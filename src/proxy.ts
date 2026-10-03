import { Agent } from "undici";
import type { ProxyTarget } from "./config.js";

/**
 * 高性能连接池调度器：
 * 启用长连接保持 (Keep-Alive)，跨请求复用 TLS 连接，
 * 显著消除与境外 AI 服务商建立握手的 150ms~300ms 首包延迟 (TTFT)。
 */
export const proxyAgent = new Agent({
  keepAliveTimeout: 60_000,
  keepAliveMaxTimeout: 600_000,
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

    // 透传所有合法的 AI 认证与业务标头（如 x-opencode-session, anthropic-version, authorization 等）
    headers.set(key, value);
  });

  return headers;
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

  // 若客户端主动取消请求，直接同步中止上游，防止连接泄漏
  if (req.signal) {
    req.signal.addEventListener("abort", () => {
      clearTimeout(timeoutId);
      controller.abort();
    });
  }

  // 严格遵循规范：GET 与 HEAD 严禁传递 Body，避免 Node.js 运行时抛出 TypeError
  const isBodyAllowed = req.method !== "GET" && req.method !== "HEAD";
  const body = isBodyAllowed ? req.body : undefined;

  try {
    const fetchOptions: any = {
      method: req.method,
      headers: forwardHeaders,
      body,
      signal: controller.signal,
      dispatcher: proxyAgent,
      duplex: isBodyAllowed && body ? "half" : undefined,
    };

    const upstreamRes = await fetch(targetUrl.toString(), fetchOptions);

    clearTimeout(timeoutId);

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

    // 零拷贝直通数据流
    return new Response(upstreamRes.body, {
      status: upstreamRes.status,
      statusText: upstreamRes.statusText,
      headers: clientResHeaders,
    });
  } catch (error: any) {
    clearTimeout(timeoutId);

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
