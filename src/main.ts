import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { proxyRouter } from "./config.js";
import { forwardProxyRequest, buildForwardHeaders, proxyAgent } from "./proxy.js";

const app = new Hono();

// 1. 全局 CORS 中间件，支持浏览器前端直接直连
app.use(cors());

// 2. 日志记录
app.use(logger());

// 3. 根路径伪装展示与健康检查
const HOME_PAGE_TEXT = `专注于优化算法及其相关领域的知识分享，欢迎您关注微信公众号《博優旮旯-boyogala》.

Dedicated to sharing knowledge on optimization algorithms and related fields. You are welcome to follow our WeChat Official Account 《博優旮旯-boyogala》.

專注於優化演算法及其相關領域的知識分享，歡迎您關注微信公眾號《博優旮旯-boyogala》。
`;

app.get("/", (c) => c.text(HOME_PAGE_TEXT));

app.get("/health", (c) =>
  c.json({
    status: "ok",
    version: "2.0.0",
    service: "ai7proxy",
  })
);

// 4. 兼容原版的自定义 URL 临时代理接口，同时补全流式与安全设置
app.post(
  "/custom-model-proxy",
  zValidator(
    "query",
    z.object({
      url: z.string().url(),
    })
  ),
  async (c) => {
    const { url } = c.req.valid("query");
    const targetUrl = new URL(url);
    const forwardHeaders = buildForwardHeaders(c.req.raw.headers, targetUrl);

    const isBodyAllowed = c.req.method !== "GET" && c.req.method !== "HEAD";
    const body = isBodyAllowed ? c.req.raw.body : undefined;

    const fetchOptions: any = {
      method: c.req.method,
      headers: forwardHeaders,
      body,
      dispatcher: proxyAgent,
      duplex: isBodyAllowed && body ? "half" : undefined,
    };

    const res = await fetch(targetUrl.toString(), fetchOptions);

    const resHeaders = new Headers(res.headers);
    resHeaders.set("X-Accel-Buffering", "no");

    return new Response(res.body, {
      headers: resHeaders,
      status: res.status,
    });
  }
);

// 5. 核心透明代理路由中间件（基于 O(1) 前缀分发）
app.use(async (c, next) => {
  const url = new URL(c.req.url);
  const match = proxyRouter.find(url.pathname, url.hostname);

  if (match) {
    return forwardProxyRequest({
      req: c.req.raw,
      proxy: match.proxy,
      matchedPrefix: match.matchedPrefix,
    });
  }

  await next();
});

export default app;
