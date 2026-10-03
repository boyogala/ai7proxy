import test, { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import app from "../src/main.js";
import { PROXIES, proxyRouter, ProxyRouter } from "../src/config.js";
import { buildForwardHeaders, buildTargetUrl } from "../src/proxy.js";

describe("ai7proxy Comprehensive Test Suite", () => {
  let mockServer: http.Server;
  let mockPort: number;
  let lastReceivedRequest: {
    method?: string;
    url?: string;
    headers?: http.IncomingHttpHeaders;
    body?: string;
  } = {};

  before(async () => {
    // 启动本地 mock upstream 服务
    mockServer = http.createServer((req, res) => {
      let bodyData = "";
      req.on("data", (chunk) => {
        bodyData += chunk;
      });
      req.on("end", () => {
        lastReceivedRequest = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: bodyData,
        };

        if (req.url?.includes("/stream")) {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });
          res.write("data: chunk 1\n\n");
          res.write("data: chunk 2\n\n");
          res.end("data: [DONE]\n\n");
          return;
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "mock_ok", url: req.url }));
      });
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, "127.0.0.1", () => {
        const address = mockServer.address() as { port: number };
        mockPort = address.port;
        resolve();
      });
    });
  });

  after(() => {
    mockServer.close();
  });

  describe("1. O(1) 路由分发器测试与服务商隔离", () => {
    it("应正确解析并隔离各大主流服务商前缀", () => {
      const matchOpenAI = proxyRouter.find("/openai/v1/chat/completions", "localhost");
      assert.ok(matchOpenAI);
      assert.equal(matchOpenAI.proxy.pathSegment, "openai");
      assert.equal(matchOpenAI.matchedPrefix, "/openai");

      const matchAnthropic = proxyRouter.find("/anthropic/v1/messages", "localhost");
      assert.ok(matchAnthropic);
      assert.equal(matchAnthropic.proxy.pathSegment, "anthropic");

      const matchGoogle = proxyRouter.find("/generativelanguage/v1beta/models", "localhost");
      assert.ok(matchGoogle);
      assert.equal(matchGoogle.proxy.pathSegment, "generativelanguage");

      const matchOpenRouter = proxyRouter.find("/openrouter/v1/chat/completions", "localhost");
      assert.ok(matchOpenRouter);
      assert.equal(matchOpenRouter.proxy.pathSegment, "openrouter");

      const matchOpenRouterApi = proxyRouter.find("/openrouter/api/v1/chat/completions", "localhost");
      assert.ok(matchOpenRouterApi);
      assert.equal(matchOpenRouterApi.proxy.pathSegment, "openrouter/api");

      const matchXAI = proxyRouter.find("/xai/v1/chat/completions", "localhost");
      assert.ok(matchXAI);
      assert.equal(matchXAI.proxy.pathSegment, "xai");
    });

    it("应正确支持单一且完整的 OpenCode V2 统一路由映射", () => {
      // 1. OpenCode Go / Zen 端点透明代理
      const matchOpenCodeGo = proxyRouter.find("/opencode/zen/go/v1/chat/completions", "localhost");
      assert.ok(matchOpenCodeGo);
      assert.equal(matchOpenCodeGo.proxy.pathSegment, "opencode");
      assert.equal(matchOpenCodeGo.proxy.target, "https://opencode.ai");

      // 验证拼接出来的最终目标 URL 准确无误
      const targetUrlGo = buildTargetUrl(
        matchOpenCodeGo.proxy,
        matchOpenCodeGo.matchedPrefix,
        "/opencode/zen/go/v1/chat/completions",
        ""
      );
      assert.equal(targetUrlGo.toString(), "https://opencode.ai/zen/go/v1/chat/completions");

      // 2. OpenCode 模型与通用端点透明代理
      const matchModels = proxyRouter.find("/opencode/zen/go/v1/models", "localhost");
      assert.ok(matchModels);
      const targetUrlModels = buildTargetUrl(
        matchModels.proxy,
        matchModels.matchedPrefix,
        "/opencode/zen/go/v1/models",
        ""
      );
      assert.equal(targetUrlModels.toString(), "https://opencode.ai/zen/go/v1/models");

      // 3. OpenCode 根端点透明代理
      const matchGeneric = proxyRouter.find("/opencode/v1/models", "localhost");
      assert.ok(matchGeneric);
      const targetUrlGeneric = buildTargetUrl(
        matchGeneric.proxy,
        matchGeneric.matchedPrefix,
        "/opencode/v1/models",
        ""
      );
      assert.equal(targetUrlGeneric.toString(), "https://opencode.ai/v1/models");
    });

    it("对非代理路径应安全返回 null，不产生任何副作用", () => {
      const matchUnknown = proxyRouter.find("/some-other-path/v1", "localhost");
      assert.equal(matchUnknown, null);
    });
  });

  describe("2. URL 精确构建与重写测试（消除原生 replace 缺陷）", () => {
    it("应安全准确拼接 URL，无论是否存在尾随斜杠", () => {
      const targetUrl = buildTargetUrl(
        { pathSegment: "openai", target: "https://api.openai.com" },
        "/openai",
        "/openai/v1/chat/completions",
        "?model=o3-mini"
      );
      assert.equal(targetUrl.toString(), "https://api.openai.com/v1/chat/completions?model=o3-mini");
    });

    it("应正确拼接带已有子路径的 upstream（如 OpenRouter API）", () => {
      const targetUrl = buildTargetUrl(
        { pathSegment: "openrouter/api", target: "https://openrouter.ai/api" },
        "/openrouter/api",
        "/openrouter/api/v1/chat/completions",
        ""
      );
      assert.equal(targetUrl.toString(), "https://openrouter.ai/api/v1/chat/completions");
    });
  });

  describe("3. 请求头清洗与各大厂商最新专用标头透传", () => {
    it("应清洗 cf-、x-forwarded-、host，并重写 Host 为 upstream 域名", () => {
      const raw = new Headers();
      raw.set("host", "my-proxy.com:4000");
      raw.set("cf-connecting-ip", "1.2.3.4");
      raw.set("x-forwarded-for", "1.2.3.4");
      raw.set("cdn-loop", "cloudflare");
      raw.set("x-real-ip", "1.2.3.4");
      raw.set("authorization", "Bearer sk-test-key");
      raw.set("x-opencode-session", "ses_abc123xyz");
      raw.set("anthropic-version", "2023-06-01");
      raw.set("anthropic-beta", "output-128k-2025-02-19,thinking-2025-01-31");
      raw.set("user-agent", "custom-coding-agent/2.0");

      const targetUrl = new URL("https://opencode.ai/zen/go/v1/chat/completions");
      const cleaned = buildForwardHeaders(raw, targetUrl);

      // 验证 Host 重写
      assert.equal(cleaned.get("host"), "opencode.ai");

      // 验证敏感代理头过滤
      assert.equal(cleaned.has("cf-connecting-ip"), false);
      assert.equal(cleaned.has("x-forwarded-for"), false);
      assert.equal(cleaned.has("cdn-loop"), false);
      assert.equal(cleaned.has("x-real-ip"), false);

      // 验证核心业务和 AI 厂商专属头保留
      assert.equal(cleaned.get("authorization"), "Bearer sk-test-key");
      assert.equal(cleaned.get("x-opencode-session"), "ses_abc123xyz");
      assert.equal(cleaned.get("anthropic-version"), "2023-06-01");
      assert.equal(cleaned.get("anthropic-beta"), "output-128k-2025-02-19,thinking-2025-01-31");
      assert.equal(cleaned.get("user-agent"), "custom-coding-agent/2.0");
    });
  });

  describe("4. 端到端请求与修复验证（Mock Upstream）", () => {
    let testRouter: ProxyRouter;

    before(() => {
      // 构造指向本地 mockServer 的专用测试路由表
      testRouter = new ProxyRouter([
        {
          pathSegment: "mock-ai",
          target: `http://127.0.0.1:${mockPort}`,
          timeout: 5000,
        },
      ]);
    });

    it("GET 请求严禁携带 Body，避免 Node.js 运行时抛出 TypeError", async () => {
      const match = testRouter.find("/mock-ai/v1/models", "localhost");
      assert.ok(match);

      const req = new Request(`http://localhost/mock-ai/v1/models`, {
        method: "GET",
        headers: {
          authorization: "Bearer test",
          "x-opencode-session": "sess-test-get",
        },
      });

      const { forwardProxyRequest } = await import("../src/proxy.js");
      const res = await forwardProxyRequest({
        req,
        proxy: match.proxy,
        matchedPrefix: match.matchedPrefix,
      });

      assert.equal(res.status, 200);
      assert.equal(lastReceivedRequest.method, "GET");
      assert.equal(lastReceivedRequest.headers?.["authorization"], "Bearer test");
      assert.equal(lastReceivedRequest.headers?.["x-opencode-session"], "sess-test-get");
      assert.equal(lastReceivedRequest.body, "");
    });

    it("POST 流式请求（SSE）与 X-Accel-Buffering 标头验证", async () => {
      const match = testRouter.find("/mock-ai/stream", "localhost");
      assert.ok(match);

      const req = new Request(`http://localhost/mock-ai/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer stream-key",
        },
        body: JSON.stringify({ prompt: "hello streaming" }),
      });

      const { forwardProxyRequest } = await import("../src/proxy.js");
      const res = await forwardProxyRequest({
        req,
        proxy: match.proxy,
        matchedPrefix: match.matchedPrefix,
      });

      assert.equal(res.status, 200);
      // 验证禁用网关缓冲，保障打字机流式输出
      assert.equal(res.headers.get("x-accel-buffering"), "no");

      // 读取流式响应内容
      const text = await res.text();
      assert.ok(text.includes("data: chunk 1"));
      assert.ok(text.includes("data: [DONE]"));
      assert.equal(lastReceivedRequest.body, JSON.stringify({ prompt: "hello streaming" }));
    });

    it("超时机制能够在长响应超时时正确返回 504", async () => {
      // 启动一个模拟故意超时的上游服务
      const hangingServer = http.createServer((_req, _res) => {
        // 故意不响应
      });

      await new Promise<void>((resolve) => hangingServer.listen(0, "127.0.0.1", () => resolve()));
      const hangingPort = (hangingServer.address() as { port: number }).port;

      const hangingRouter = new ProxyRouter([
        {
          pathSegment: "hanging-ai",
          target: `http://127.0.0.1:${hangingPort}`,
          timeout: 50, // 50ms 极短超时
        },
      ]);

      const match = hangingRouter.find("/hanging-ai/test", "localhost");
      assert.ok(match);

      const req = new Request("http://localhost/hanging-ai/test", {
        method: "POST",
        headers: { "x-proxy-timeout": "100" }, // 100ms 超时
        body: JSON.stringify({ ping: "hang" }),
      });

      const { forwardProxyRequest } = await import("../src/proxy.js");
      const res = await forwardProxyRequest({
        req,
        proxy: match.proxy,
        matchedPrefix: match.matchedPrefix,
      });

      assert.equal(res.status, 504);
      const json = await res.json();
      assert.equal(json.error.type, "timeout_error");

      hangingServer.close();
    });
  });

  describe("5. Hono 全局入口路由验证", () => {
    it("访问 GET / 返回伪装首页知识分享文本", async () => {
      const res = await app.request("/");
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes("博優旮旯-boyogala"));
      assert.ok(text.includes("optimization algorithms"));
    });

    it("访问 GET /health 返回健康状态", async () => {
      const res = await app.request("/health");
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, "ok");
      assert.equal(json.service, "ai7proxy");
    });
  });
});
