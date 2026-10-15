import { Agent } from "undici";
import { DEFAULT_TIMEOUT_MS, type ProxyTarget } from "./config.js";

/**
 * 高性能连接池调度器：
 * 启用长连接保持 (Keep-Alive)，跨请求复用 TLS 连接，
 * 显著消除与境外 AI 服务商建立握手的 150ms~300ms 首包延迟 (TTFT)。
 * 同时将底层 headersTimeout 与 bodyTimeout 提升至 15 分钟 (900,000ms)，
 * 避免 undici 默认 300s 超时提前中断深度思考模型或 OpenCode 长推理请求。
 */
export const proxyAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
  headersTimeout: DEFAULT_TIMEOUT_MS,
  bodyTimeout: DEFAULT_TIMEOUT_MS,
  connect: {
    timeout: 30_000,
  },
  pipelining: 1,
  connections: 512,
});

/**
 * Hop-by-hop 标头与代理敏感标头集合（一律不向下游/上游透传）
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * 响应阶段需剥离的可能导致解压或传输冲突的标头
 */
const STRIP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "transfer-encoding",
  "content-length",
  "connection",
  "keep-alive",
]);

/**
 * 清洗客户端请求头，重写 Host，并确保各大 AI 厂商的专属标头完整无损透传
 */
export function buildForwardHeaders(rawHeaders: Headers, targetUrl: URL): Headers {
  const headers = new Headers();

  // 1. 重写 Host 为真实 upstream 域名
  headers.set("host", targetUrl.host);

  // 2. 遍历并清洗客户端传入的头部
  rawHeaders.forEach((value, key) => {
    const lowerKey = key.toLowerCase();

    // 过滤 hop-by-hop
    if (HOP_BY_HOP_HEADERS.has(lowerKey)) {
      return;
    }

    // 过滤 CDN 与代理标记，防止 upstream 网关识别为非法多级代理
    if (
      lowerKey.startsWith("cf-") ||
      lowerKey.startsWith("x-forwarded-") ||
      lowerKey.startsWith("cdn-") ||
      lowerKey === "x-real-ip"
    ) {
      return;
    }

    // 透传所有合法的 AI 认证与业务标头：
    // - 认证类: authorization, x-api-key, api-key, x-goog-api-key
    // - OpenCode V2 组织与会话类: x-org-id, x-opencode-org-id, x-opencode-session, x-opencode-session-id,
    //   x-opencode-parent-session-id, x-session-affinity, x-session-id, x-opencode-project, x-opencode-client, b3, traceparent
    // - 协议与压缩类: user-agent, anthropic-version, anthropic-beta, content-encoding (zstd/gzip) 等
    headers.set(key, value);
  });

  return headers;
}

/**
 * 精确判定请求是否携带有效 Body：
 * 1. GET 与 HEAD 严禁携带 Body；
 * 2. Content-Length 显式为 "0" 时不传递流式 Body；
 * 3. DELETE / OPTIONS 若未声明非零 Content-Length 且无 Transfer-Encoding（如 OpenCode Budgets API DELETE），
 *    不传递空 ReadableStream，防止 undici 注入 Transfer-Encoding: chunked 导致上游网关拒绝。
 */
export function hasRequestBody(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD") {
    return false;
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength === "0") {
    return false;
  }

  if (
    (method === "DELETE" || method === "OPTIONS") &&
    contentLength === null &&
    !req.headers.has("transfer-encoding")
  ) {
    return false;
  }

  return Boolean(req.body);
}

/**
 * 判定响应状态码是否为 RFC / Fetch 规范定义的无响应体状态（如 204 No Content, 205, 304）
 */
export function isNullBodyStatus(status: number, method?: string): boolean {
  if (method && method.toUpperCase() === "HEAD") {
    return true;
  }
  return status === 204 || status === 205 || status === 304;
}

/**
 * 安全构建目标上游 URL，精确剥除匹配前缀，规避原生 replace 的误替换风险
 */
export function buildTargetUrl(
  proxy: ProxyTarget,
  matchedPrefix: string,
  pathname: string,
  search: string,
): URL {
  let subPath = pathname.slice(matchedPrefix.length);

  if (subPath.length > 0 && !subPath.startsWith("/")) {
    subPath = "/" + subPath;
  }

  // 处理根路径边缘情况
  if (subPath === "/") {
    subPath = "";
  }

  // 确保 proxy.target 结尾与 subPath 开头斜杠拼接规范
  const baseTarget = proxy.target.endsWith("/") ? proxy.target.slice(0, -1) : proxy.target;
  const fullUrlString = `${baseTarget}${subPath}${search}`;

  return new URL(fullUrlString);
}

export interface ProxyForwardOptions {
  req: Request;
  proxy: ProxyTarget;
  matchedPrefix: string;
}

/**
 * 执行透明转发：支持全流式传输、长超时控制、连接复用以及响应头重构
 */
export async function forwardProxyRequest({
  req,
  proxy,
  matchedPrefix,
}: ProxyForwardOptions): Promise<Response> {
  const reqUrl = new URL(req.url);
  const targetUrl = buildTargetUrl(proxy, matchedPrefix, reqUrl.pathname, reqUrl.search);
  const forwardHeaders = buildForwardHeaders(req.headers, targetUrl);

  // 统一超时控制：基准为 15 分钟（900,000ms），支持客户端通过 X-Proxy-Timeout 临时自定义
  const headerTimeout = req.headers.get("x-proxy-timeout");
  const timeoutMs = headerTimeout ? parseInt(headerTimeout, 10) : (proxy.timeout ?? 900_000);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  // 若客户端在等待上游响应头阶段主动取消请求，直接同步中止上游，防止连接泄漏；
  // 一旦响应头返回并进入流式传输阶段，移除该监听，交由 @hono/node-server 的 writable close 机制平滑调用 reader.cancel()，
  // 避免 controller.abort() 触发未捕获的 DOMException [AbortError] 污染日志。
  const onClientAbort = () => {
    clearTimeout(timeoutId);
    controller.abort();
  };
  if (req.signal) {
    req.signal.addEventListener("abort", onClientAbort, { once: true });
  }

  // 严格遵循规范：精确判定是否携带有效请求体，避免 GET/HEAD 抛出 TypeError 或空 DELETE 注入 chunked
  const sendBody = hasRequestBody(req);
  const body = sendBody ? req.body : undefined;

  try {
    const fetchOptions: any = {
      method: req.method,
      headers: forwardHeaders,
      body,
      signal: controller.signal,
      dispatcher: proxyAgent,
      duplex: sendBody && body ? "half" : undefined,
    };

    const upstreamRes = await fetch(targetUrl.toString(), fetchOptions);

    clearTimeout(timeoutId);
    if (req.signal) {
      req.signal.removeEventListener("abort", onClientAbort);
    }

    // 构造转发给客户端的响应头
    const clientResHeaders = new Headers();
    upstreamRes.headers.forEach((val, k) => {
      const lower = k.toLowerCase();
      if (!STRIP_RESPONSE_HEADERS.has(lower)) {
        clientResHeaders.set(k, val);
      }
    });

    // 针对大模型 SSE 流式输出，强制禁用外部网关与反向代理缓冲
    clientResHeaders.set("X-Accel-Buffering", "no");

    // 零拷贝直通数据流（针对 204/205/304 如 OpenCode Budgets API PUT/DELETE 严格返回 null body）
    const nullBody = isNullBodyStatus(upstreamRes.status, req.method);
    return new Response(nullBody ? null : upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: clientResHeaders,
    });
  } catch (error: any) {
    clearTimeout(timeoutId);
    if (req.signal) {
      req.signal.removeEventListener("abort", onClientAbort);
    }

    if (controller.signal.aborted) {
      return new Response(
        JSON.stringify({
          error: {
            message: `Gateway timeout: upstream did not respond within ${timeoutMs}ms`,
            type: "timeout_error",
            code: 504,
          },
        }),
        {
          status: 504,
          headers: {
            "Content-Type": "application/json",
            "X-Accel-Buffering": "no",
          },
        },
      );
    }

    return new Response(
      JSON.stringify({
        error: {
          message: error?.message || "Internal Proxy Gateway Error",
          type: "proxy_error",
          code: 502,
        },
      }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "X-Accel-Buffering": "no",
        },
      },
    );
  }
}
