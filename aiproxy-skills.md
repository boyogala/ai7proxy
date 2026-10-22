---
name: aiproxy-skills
description: 基于开源 ai-proxy 深度重构与构建生产级、高性能、防风控、支持 OpenCode v2 与超长思考推理模型的企业级 AI 透明代理服务 (ai7proxy) 全流程实战指南与智能体工程技能。
---

# 🚀 AI Transparent Proxy Engineering Skill (ai7proxy)

本技能沉淀了一套**从旧版开源代理到企业级高性能 AI 透明代理服务（ai7proxy）**的完整工程构建、性能调优、安全防风控、OpenCode v2 深度对接、Linux systemd 一键运维及零跳步部署的最佳实践。

---

## 🧭 目录导航

1. [技能定位与解决痛点](#1-技能定位与解决痛点)
2. [底层核心缺陷修复与性能重构架构](#2-底层核心缺陷修复与性能重构架构)
3. [网络特征清洗与学术伪装防风控工程](#3-网络特征清洗与学术伪装防风控工程)
4. [OpenCode v2 客户端深度集成标准与配置真相](#4-opencode-v2-客户端深度集成标准与配置真相)
5. [Linux (systemd) 一键自动化运维脚本规范 (proxy2ai)](#5-linux-systemd-一键自动化运维脚本规范-proxy2ai)
6. [零跳步打包、GitHub 同步、Releases 发版与生产部署流水线](#6-零跳步打包github-同步releases-发版与生产部署流水线)
7. [Git 历史深度脱敏与安全开源标准](#7-git-历史深度脱敏与安全开源标准)
8. [生产实战 FAQ 与网络排查深度案例](#8-生产实战-faq-与网络排查深度案例)

---

## 1. 技能定位与解决痛点

### 1.1 触发场景与解决的核心问题
当智能体或开发者面临以下需求时，应调用本技能：
- **自建高性能 AI 网关**：需要稳定代理 OpenAI、Anthropic (Claude 3.7)、Google Gemini、xAI (Grok)、OpenRouter、OpenCode 等多厂商 API；
- **解决长思考模型断连 (504 Gateway Timeout)**：应对 OpenAI o1/o3、Claude 3.7 Sonnet Thinking、Gemini 2.5 等深度推理模型因耗时超过 60 秒被原生反代强行掐断的痛点；
- **消除运行时崩溃异常**：彻底修复在 Node.js 20+ 环境下透传 GET/HEAD 请求体导致的 `TypeError: Request with GET/HEAD method cannot have body` 致命错误；
- **消除重复握手延迟**：解决旧版代理每次新建临时 TCP 连接导致的 +200ms 重复 TLS 握手延迟；
- **防域名扫描与安全风控**：隐藏 AI 代理痕迹，剥离客户端真实 IP，根路径伪装合法知识分享主页，避免域名被标记或封禁。

---

## 2. 底层核心缺陷修复与性能重构架构

### 2.1 O(1) 前缀哈希路由隔离器 (`ProxyRouter`)
旧版代理采用 `Array.find()` 在每次 HTTP 请求到达时进行 O(N) 线性字符串正则扫描，容易导致服务商前缀冲突且存在性能开销。
- **最佳实践**：使用 `Map<string, ProxyTarget[]>` 建立首段路径 Radix 前缀索引：
  - 提取请求路径的第一级目录（如 `/openai/`、`/anthropic/`、`/opencode/`）；
  - O(1) 复杂度瞬间定位目标服务商，各大服务商完全独立隔离，互不干扰；
  - 非代理路径立即返回 `null`，放行至静态路由与中间件。

### 2.2 Undici Keep-Alive 高性能连接池复用
每次请求新建连接会产生严重的 TLS 握手开销（多轮 RTT，约 150ms ~ 300ms），且 Undici 默认的 `headersTimeout` / `bodyTimeout` 仅为 300 秒（5分钟），会在长思考模型 15 分钟超时前提前断开连接。
- **最佳实践**：引入 Node.js 官方底层的 `undici.Agent`，并显式对齐长推理超时：
  ```ts
  import { Agent } from "undici";

  export const proxyAgent = new Agent({
    keepAliveTimeout: 60_000,            // 60秒空闲保活
    keepAliveMaxTimeout: 600_000,        // 最长连接生命周期 10分钟
    headersTimeout: DEFAULT_TIMEOUT_MS,  // 900,000ms (15分钟) 首包响应头超时，防止深度思考阶段被底层提前掐断
    bodyTimeout: DEFAULT_TIMEOUT_MS,     // 900,000ms (15分钟) 流式响应体间隔超时
    pipelining: 1,                       // 严格保障请求时序
    connect: { timeout: 30_000 },        // TCP 建连超时 30秒
  });
  ```
  请求通过 `dispatcher: proxyAgent` 派发，后续同一厂商的并发请求直接复用已建立的 TLS 隧道，握手延迟降至 **~0ms**。

### 2.3 统一 15 分钟（900s）长推理超时机制与 Abort 信号清理
- 废弃 60s 硬编码限制，将全局基准超时设置为 `900,000ms`（15分钟）；
- 兼容各大厂商与自定义客户端的动态请求头覆盖：检测客户端传入的 `x-proxy-timeout`（毫秒），支持会话级自定义长超时；
- **流式完成后的信号解绑**：一旦上游返回响应头并进入 Web Streams 流式透传阶段，立即执行 `req.signal.removeEventListener("abort", onClientAbort)`，防止客户端在收到 `[DONE]` 正常关闭连接时触发 `controller.abort()` 导致日志刷出 `DOMException [AbortError]` 噪音。

### 2.4 RFC 规范、无 Body 状态码（HTTP 204 / DELETE）与流式传输（SSE 直通）
- **智能请求体判定 (`hasRequestBody`)**：
  ```ts
  function hasRequestBody(req: Request): boolean {
    if (req.method === "GET" || req.method === "HEAD") return false;
    if (!req.body) return false;
    const contentLength = req.headers.get("content-length");
    const transferEncoding = req.headers.get("transfer-encoding");
    if (req.method === "DELETE" && (!contentLength || contentLength === "0") && !transferEncoding) {
      return false;
    }
    return true;
  }
  ```
  从根源上杜绝 Node.js 运行时由于 GET/HEAD 携带 Body 抛出的 `TypeError`，同时完美兼容 OpenCode V2 Budgets API 的无请求体 `DELETE` 请求。
- **无响应体状态码规范支持 (`isNullBodyStatus`)**：
  针对 HTTP `101`、`204 No Content`（如 OpenCode Budgets API 的 `PUT`/`DELETE /api/v1/budgets/members/:user_id`）、`205`、`304` 响应，返回 `new Response(null, { status, headers })`，避免 `new Response(upstreamResponse.body, { status: 204 })` 在符合 Fetch 规范的运行时中抛出异常。
- **打字机直通与防缓冲**：
  响应头显式强制注入：`resHeaders.set("X-Accel-Buffering", "no")`，彻底禁止 Nginx / Cloudflare 在中间层对 SSE（Server-Sent Events）进行流式积攒，保证前端实时打字机效果。

---

## 3. 网络特征清洗与学术伪装防风控工程

### 3.1 客户端特征与 Hop-by-hop 标头深度清洗
为了保护调用者的绝对隐私，并防止上游 AI 服务商识别出反向代理特征：
1. **剥离客户端指纹标头**：
   清洗 `cf-connecting-ip`、`cf-ipcountry`、`cf-ray`、`cf-visitor`、`x-forwarded-for`、`x-forwarded-proto`、`x-real-ip`、`cdn-loop`；
   *（上游 AI 服务商在安全审查时仅能看到 Linux VPS 的原生出口 IP）*；
2. **清洗标准 Hop-by-hop 协议头**：
   清洗 `connection`、`keep-alive`、`proxy-authenticate`、`proxy-authorization`、`te`、`trailer`、`transfer-encoding`、`upgrade`；
3. **域名 Host 重写**：
   将 `Host` 头部强制重写为目标官方域名（如 `api.openai.com`、`generativelanguage.googleapis.com`）。

### 3.2 根路径学术/知识分享主页伪装
在公网环境下，访问根路径暴露代理版本信息极易被搜索引擎爬虫、网络资产测绘引擎（如 Shodan、Censys）和风控扫描器打上“AI Proxy”标签。
- **最佳实践**：在 `src/main.ts` 中将根路径 `GET /` 伪装为个人/开源组织的合法学术或知识分享声明（如“优化算法与知识交流主页”），彻底消除代理特征；
- 健康检查仅保留 `/health` 路径供探活监控使用。

---

## 4. OpenCode v2 客户端深度集成标准与配置真相

### 4.1 单一统一根路由架构与 Zen / Go 双通道共享连接池机制
OpenCode 官方提供两种核心的模型使用与计费方式：
1. **OpenCode Zen 通道（内置服务商 ID：`"opencode"`）**：充值 Credits 按量扣费模型 + 官方免费模型，官方网关路径为 `https://opencode.ai/inference/v1`（向下兼容 `/zen/v1`）；
2. **OpenCode Go 通道（内置服务商 ID：`"opencode-go"`）**：Go / Go Plus 包月会员订阅模型（额度内不额外扣费），官方网关路径为 `https://opencode.ai/inference/go/v1`（向下兼容 `/zen/go/v1`）。

- **为什么 `ai7proxy` 采用“唯一一条统一根规则”而非拆成多条子路由？**
  在 `src/config.ts` 中，`ai7proxy` 对整个 OpenCode 生态只维护唯一一条根映射定义：
  ```ts
  {
    pathSegment: "opencode",
    target: "https://opencode.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  }
  ```
  - **实现机制**：当请求 `/opencode/...` 到达时，`ProxyRouter.find()` 以 **$O(1)$ 复杂度**匹配首段目录 `"opencode"`，`buildTargetUrl()` 精确剥离 `/opencode` 前缀并将剩余全部子路径原封不动拼接到 `https://opencode.ai` 后。
  - **共享连接池的低延迟优势**：由于 Zen (`/inference/v1`)、Go (`/inference/go/v1`)、SystemOne (`/inference/v1/systemone`)、Custom Providers (`/inference/custom/<connection_id>`) 以及 Console/Budgets API (`/console/...`) 在上游共享同一个 Origin (`https://opencode.ai:443`)，`undici.Agent` 在底层会让 Zen 和 Go **直接复用同一条已建立的 TCP + TLS 1.3 加密长连接隧道**，跨通道切换模型的握手延迟为 **~0ms**！
  - **单条规则自动透明覆盖的全部官方路径**：
    - 官方根网关：`https://your-domain.com/opencode/...` -> `https://opencode.ai/...`
    - **Zen 通道（Console Inference 按量付费与免费模型统一网关）**：`https://your-domain.com/opencode/inference/v1` -> `https://opencode.ai/inference/v1`（兼容 `/opencode/zen/v1`）
    - **Go 通道（OpenCode Go 订阅精选编码模型网关）**：`https://your-domain.com/opencode/inference/go/v1` -> `https://opencode.ai/inference/go/v1`（兼容 `/opencode/zen/go/v1`）
    - Console Inference 协议族网关：
      - OpenAI Chat / Responses：`https://your-domain.com/opencode/inference/openai/v1/...` -> `https://opencode.ai/inference/openai/v1/...`
      - Anthropic Messages：`https://your-domain.com/opencode/inference/anthropic/v1/messages` -> `https://opencode.ai/inference/anthropic/v1/messages`
      - Google Gemini：`https://your-domain.com/opencode/inference/google/v1beta/models/<model>:generateContent` -> `https://opencode.ai/inference/google/v1beta/models/<model>:generateContent`
      - SystemOne (Jev 决策模型)：`https://your-domain.com/opencode/inference/v1/systemone` -> `https://opencode.ai/inference/v1/systemone`
    - 工作区连接服务商 (Providers API)：`https://your-domain.com/opencode/inference/custom/<connection_id>/...` -> `https://opencode.ai/inference/custom/<connection_id>/...`
    - 控制台配置与预算管理 (Console & Budgets API)：`https://your-domain.com/opencode/console/api/v2/config`、`https://your-domain.com/opencode/console/api/v1/budgets/members`

### 4.2 客户端标准配置模板 (`opencode.jsonc`) 与 Zen / Go 自动分流
虽然 `ai7proxy` 服务端只需一条 `/opencode` 规则，但 OpenCode 客户端通过不同的内置服务商 ID（`"opencode"` 与 `"opencode-go"`）及对应的 URL 子路径来区分扣费账户（因为 `kimi-k3`、`glm-5.3`、`deepseek-v4-pro` 等模型同时存在于 Zen 和 Go 中）。在 `opencode.jsonc` 中同时配置两者后，选择 `opencode/<模型>` 或 `opencode-go/<模型>` 即可自动走对应代理通道：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    "anthropic": {
      "settings": {
        "baseURL": "https://your-domain.com/anthropic",
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    },
    "openai": {
      "settings": {
        "baseURL": "https://your-domain.com/openai/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    },
    "google": {
      "settings": {
        "baseURL": "https://your-domain.com/generativelanguage",
        "apiKey": "{env:GEMINI_API_KEY}"
      }
    },
    "xai": {
      "settings": {
        "baseURL": "https://your-domain.com/xai",
        "apiKey": "{env:XAI_API_KEY}"
      }
    },
    "openrouter": {
      "settings": {
        "baseURL": "https://your-domain.com/openrouter",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      }
    },
    // OpenCode Zen 通道：充值 Credits 按量扣费模型 + 免费模型（使用 opencode/<模型> 时自动走此通道）
    // 注意：OpenCode v2.1.2+ 目录在 opencode / opencode-go 的每个模型内部自带了 provider.api (model.settings.baseURL)，
    // 合并配置时模型级 baseURL 优先级高于服务商顶层 baseURL；
    // 仅需在 models 下配置国外模型走代理，国内模型（Kimi/GLM/DeepSeek/Qwen/MiniMax/MiMo/LongCat等）无需声明，保持直连即可
    "opencode": {
      "settings": {
        "baseURL": "https://your-domain.com/opencode/inference/v1",
        "apiKey": "{env:OPENCODE_API_KEY}"
      },
      "models": {
        "gpt-6-luna": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "gpt-5.6-luna": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "gpt-5-nano": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "muse-wonder-1.0": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "beam-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "flint-40b-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "nemotron-3.5-super-vl-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "nemotron-3.5-lightning-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "nemotron-3-ultra-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/openai/v1" } },
        "claude-haiku-5-5": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/anthropic/v1" } },
        "gemini-3.5-flash-lite": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/google/v1beta" } }
      }
    },
    // OpenCode Go 通道：Go / Go Plus 包月订阅会员模型（仅代理国外模型，国内模型保持直连）
    "opencode-go": {
      "settings": {
        "baseURL": "https://your-domain.com/opencode/inference/go/v1",
        "apiKey": "{env:OPENCODE_API_KEY}"
      },
      "models": {
        "gpt-6-luna": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "gpt-5.6-luna": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "grok-4.7": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "beam-free": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "muse-spark-1.3-contributor": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "muse-spark-1.2-contributor": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/openai/v1" } },
        "claude-haiku-5-5": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/anthropic/v1" } },
        "gemini-4-argon-contributor": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/google/v1beta" } }
      }
    }
  }
}
```

### 4.3 核心机制真相：“给出具体模型” vs “不给出具体模型”与“严禁顶层声明 `package`”
很多开发者对该配置存在严重误解，智能体应向使用者清晰阐明底层逻辑：

| 配置策略 | 声明方式 | 行为逻辑与可用范围 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **不给具体模型** *(强烈推荐)* | 只配置 `baseURL` + `apiKey`，**不写 `models: {}`** | **该服务商官方开放的所有可用模型全部直接可用！** 客户端会自动继承 OpenCode 内置官方目录（`models.dev`）。敲 `/models` 官方最新全量模型全选可用。 | **日常开发最佳实践**。零维护成本，官方发布新模型无需修改配置即可直接使用。 |
| **显式给出具体模型** | 显式声明 `models: { "model-id": { ... } }` | **增量覆盖/定制模式**。用于自定义尚未收录的模型、指定专属 Token 上限、或设置 `"disabled": true` 隐藏特定高消费模型。 | 接入内测模型、团队权限成本管控、或为特定模型锁定 `#low` / `#high` 思考档位。 |

> ⚠️ **核心避坑法则 1（严禁在 `"opencode"` / `"opencode-go"` 顶层声明 `"package"`）**：
> `"opencode"` 与 `"opencode-go"` 属于跨协议族的内置服务商（内部同时包含走 `/responses` 的 GPT/Grok/Muse、走 `/messages` 的 Claude/MiniMax/Qwen、走 `/models/...:generateContent` 的 Gemini，以及走 `/chat/completions` 的 GLM/Kimi/DeepSeek/Beam）。**切勿在 `"opencode"` 或 `"opencode-go"` 块中添加 `"package": "@opencode/ai/providers/openai-compatible"`**，否则 OpenCode v2 会清空模型自带的专属协议适配器，导致非 `/chat/completions` 协议的模型全部报错！
>
> ⚠️ **核心避坑法则 2（OpenCode v2.1.2+ 中 `"opencode"` 与 `"opencode-go"` 的模型级 `baseURL` 优先级机制）**：
> 在 OpenCode v2.1.2+ 的最新官方目录（`models.opencode.ai/api.json`）中，单一协议服务商（`openai`、`anthropic`、`google`、`xai`、`openrouter`）的模型对象没有 `provider.api` 字段，因此只配服务商顶层 `settings.baseURL` 即可代理旗下全部模型；但 `"opencode"`（130 个模型）与 `"opencode-go"`（33 个模型）在**每一个模型对象内部都硬编码了 `model.provider.api`**（即模型级 `model.settings.baseURL`，如 `https://opencode.ai/inference/go/openai/v1`、`.../anthropic/v1`、`.../google/v1beta`）。由于 OpenCode 在 `Model.snapshot` 中执行 `merge(provider.settings, model.settings)` 时模型级 `baseURL` 优先级高于服务商顶层 `baseURL`，因此对 `"opencode"` 和 `"opencode-go"` **必须在 `models` 下同步覆写对应模型的 `settings.baseURL`**，否则请求会绕过代理直接连向 `https://opencode.ai`！
>
> ⚠️ **核心避坑法则 3**：`ai7proxy` 仅为高性能透明管道，**绝不会限制或裁剪任何模型名称**。推理思考（Thinking）、图片/PDF 多模态及工具调用（Tools）全部在客户端与官方之间天然透传，日常无需手动重写 `capabilities`。

---

## 5. Linux (systemd) 一键自动化运维脚本规范 (proxy2ai)

为了摆脱对 Docker 的重型依赖并实现极致性能，设计原生 `systemd` 管理脚本 `proxy2ai`：

### 5.1 关键脚本设计原则
1. **工作目录自适应探测**：
   ```bash
   SCRIPT_PATH="$(readlink -f "$0")"
   PROJECT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
   ```
   无论脚本放在 `/opt/ai7proxy` 还是任意临时路径，自动精准识别真实所在目录，动态写入 systemd 的 `WorkingDirectory`。
2. **全自动环境自愈**：
   自动检测系统的 Node.js 版本，若缺失或低于 v20，自动通过 NodeSource 源无人值守安装 Node.js 22 LTS 与构建工具链。
3. **防权限丢失的自愈式全局指令包装脚本 (`/usr/local/bin/proxy2ai`)**：
   在 Windows 上打包 `.zip` 并在 Linux VPS 上通过 `unzip -o` 覆盖解压时，`/opt/ai7proxy/proxy2ai` 经常会丢失 `+x` 可执行权限（若使用传统 `ln -sf` 软链接会导致执行 `proxy2ai restart` 报 `Permission denied`）。因此 `/usr/local/bin/proxy2ai` 采用自愈包装脚本：
   ```bash
   cat > /usr/local/bin/proxy2ai <<EOF
   #!/usr/bin/env bash
   chmod +x "${PROJECT_DIR}/proxy2ai" "${PROJECT_DIR}/proxy2ai.sh" 2>/dev/null || true
   exec "${PROJECT_DIR}/proxy2ai" "\$@"
   EOF
   chmod +x /usr/local/bin/proxy2ai
   ```

### 5.2 标准运维命令集
```bash
proxy2ai          # 首次运行一键自动化安装、编译与启动
proxy2ai status   # 检查 systemd 后台常驻状态
proxy2ai log      # 跟踪打印实时转发流量日志
proxy2ai stop     # 彻底停止后台服务（修改代码前执行）
proxy2ai restart  # 2秒内自动重新编译并热重启（修改代码后执行）
proxy2ai uninstall# 彻底移除服务文件并清理整个项目，零残留卸载
```

---

## 6. 零跳步打包、GitHub 同步、Releases 发版与生产部署流水线

### 第一步：本地安全打包（严格排除垃圾文件）
在项目根目录执行打包，必须排除 `node_modules/`、`dist/` 与 `.git/`，且保持文件在压缩包根层级（便于 `unzip -o ... -d /opt/ai7proxy` 直接覆盖）：

```bash
# Linux / macOS 终端打包（以按日期命名 ai7proxy20261015.zip 为例）
cd /path/to/ai7proxy
rm -f ai7proxy20261015.zip && zip -r ai7proxy20261015.zip \
  src \
  test \
  aiproxy-skills.md \
  Dockerfile \
  package.json \
  package-lock.json \
  proxy2ai \
  proxy2ai.sh \
  README.md \
  tsconfig.json \
  .gitignore

# 校验压缩包内容列表
unzip -l ai7proxy20261015.zip
```

```powershell
# Windows PowerShell 打包
Compress-Archive -Path src, test, aiproxy-skills.md, Dockerfile, package.json, package-lock.json, proxy2ai, proxy2ai.sh, README.md, tsconfig.json, .gitignore -DestinationPath ai7proxy20261015.zip -Force
```

### 第二步：将最新源码推送至 GitHub 仓库并发布 Releases 附件
1. **推送源码到 GitHub (`https://github.com/boyogala/ai7proxy.git`)**：
   ```bash
   npm run build && npm test
   git status
   git add .
   git commit -m "feat: 全面适配 OpenCode V2 多协议网关、Go 订阅路由与 HTTP 204/超时稳定性增强"
   git push -u origin main
   ```
2. **上传 `ai7proxy20261015.zip` 到 GitHub Releases**：
   - **网页端方式**：访问 `https://github.com/boyogala/ai7proxy/releases/new` -> 在 `Choose a tag` 创建新标签（如 `v2026.10.15`） -> 填写标题与说明 -> 将 `ai7proxy20261015.zip` 拖入底部 `Attach binaries` 区域 -> 点击 **Publish release**。
   - **GitHub CLI (`gh`) 终端一键方式**：
     ```bash
     gh release create v2026.10.15 ./ai7proxy20261015.zip \
       --title "ai7proxy v2026.10.15" \
       --notes "全面适配 OpenCode V2 多协议网关、Go 订阅路由与 HTTP 204/超时稳定性增强"
     ```

### 第三步：本地终端一键上传至 VPS 并规范部署至 `/opt/ai7proxy`
```bash
# 1. 本地上传压缩包至 VPS
scp ai7proxy20261015.zip root@<你的VPS_IP>:/root/

# 2. 登录 VPS 解压并启动
ssh root@<你的VPS_IP>
apt-get update -y && apt-get install -y unzip
mkdir -p /opt/ai7proxy
unzip -o /root/ai7proxy20261015.zip -d /opt/ai7proxy
cd /opt/ai7proxy && chmod +x proxy2ai && ./proxy2ai
```

### 第四步：后续代码热更新流程（极简 3 步）
1. 本地打包上传：`scp ai7proxy20261015.zip root@<VPS_IP>:/root/`
2. VPS 静默覆盖解压：`unzip -o /root/ai7proxy20261015.zip -d /opt/ai7proxy`
3. VPS 极速热重启：`proxy2ai restart`

---

## 7. Git 历史深度脱敏与安全开源标准

在开源或将代码推送到 GitHub 时，安全风控与敏感信息泄露防范是重中之重：

### 7.1 本地静态扫描三原则
在提交前必须对全项目目录执行正则深度检索：
- **域名敏感扫描**：确保无任何包含个人测试域名（如 `proxy.example-test.xyz`）的遗留，全部替换为标准范例域名（`https://your-domain.com`）；
- **公网 IP 扫描**：确保无任何真实物理云机房公网 IP，仅允许出现 `127.0.0.1` 及测试 Mock 假 IP；
- **API Key 与密码扫描**：确保无任何 `sk-` 真实密钥或服务器密码，配置示例统一使用 `{env:VARIABLE_NAME}` 占位。

### 7.2 彻底抹除 Git Commit 历史（重写历史防翻阅）
若早期提交曾不慎包含敏感域名，即使后续提交新 Commit 修正，他人也能通过翻阅历史 Commit Diff 查看到敏感信息。
- **最佳彻底脱敏方案**：
  ```bash
  # 1. 将所有脱敏后的修改加入暂存区
  git add .

  # 2. 合入覆盖上一个提交，抹除旧快照
  git commit --amend --no-edit

  # 3. 强制推送覆盖远程 GitHub 仓库
  git push --force origin main
  ```
  执行后，Git 历史记录将彻底洁净，100% 杜绝历史翻阅风险。

---

## 8. 生产实战 FAQ 与网络排查深度案例

### 实战案例一：调用 Google Gemini 提示 `User location is not supported`，但探测连通性却返回 `HTTP/2 404`？

#### 现象再现：
在 VPS 终端执行探测：
```text
root@VM-xxxx:~# curl -I https://generativelanguage.googleapis.com
HTTP/2 404
server: scaffolding on HTTPServer2
...
```
而在使用 Gemini API 时却抛出：
```json
{
  "error": {
    "code": 403,
    "message": "User location is not supported for the API use.",
    "status": "FAILED_PRECONDITION"
  }
}
```

#### 深度原因剖析（打破开发者常见误区）：
1. **`HTTP/2 404` 证明网络层 100% 畅通！**
   - 包含 `server: scaffolding on HTTPServer2`（Google 官方网关代号），说明 **VPS 到 Google 的底层 TCP 路由与 TLS 443 加密握手完全通畅，没有任何物理网络阻断**；
   - 之所以返回 404，是因为 Google 微服务 API 的根路径 `/` 没有挂载网页资源，网关探测默认响应 404，属于官方标准行为。
2. **真正的拦截发生在“API 业务逻辑层”**：
   - 代理由于剥离了客户端真实 IP，Google 在业务层接收到具体接口请求（如 `/v1beta/models`）时，审查的是该 Linux VPS 本身的出口 IP；
   - 若该 VPS 位于中国大陆、中国香港（部分机房段）或被列入风控库的 IDC 广播段，便会在业务层触发合规拦截（`403 User location is not supported`）。

#### 权威排查与解决方案：
1. **精准定位 IP 归属**：执行 `curl -s https://ipinfo.io/json` 查看 `country` 与 `org`；
2. **真实业务请求探测**：
   `curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=你的GEMINI_API_KEY"`，直观确认是否命中地区封锁；
3. **根治方案**：
   - **方案 A（最佳）**：部署在 Google 官方原生支持的国家/地区 VPS（美国、日本、新加坡、欧洲等合规节点）；
   - **方案 B（出口解锁）**：在现有 VPS 上安装 Cloudflare WARP 免费配置出站分流，将对外流量由原生合规节点转出。

---

### 实战案例二：在 OpenCode 中调用免费测试模型（如 `cat-jam-free`）返回 `502 inference_failed` 时，如何判断是代理服务故障还是官方上游算力超时？

#### 现象再现：
在 `opencode.jsonc` 中配置好 `"opencode"` (`/opencode/inference/v1`) 和 `"opencode-go"` (`/opencode/inference/go/v1`) 后，使用 `cat-jam-free` 模型时收到如下错误日志：
```json
{
  "event": {
    "outcome": "failed",
    "category": "inference",
    "protocol": "openai-chat",
    "product": "standard",
    "path": "/inference/v1/chat/completions",
    "requestedModel": "cat-jam-free",
    "statusCode": 502,
    "errorCode": "inference_failed",
    "errorMessage": "The inference request failed.",
    "reasoningMode": "effort",
    "reasoningEffort": "max",
    "country": "US",
    "region": "California",
    "city": "Los Angeles",
    "attemptCount": 2,
    "attempts": [
      { "provider": "opencode", "model": "cat-jam-free", "statusCode": 502, "durationMs": 30113, "errorCode": "inference_failed" },
      { "provider": "opencode", "model": "cat-jam-free", "statusCode": 502, "durationMs": 10149, "errorCode": "inference_failed" }
    ]
  }
}
```

#### 深度诊断方法（3 秒定性是否与 `ai7proxy` 有关）：
1. **看错误 JSON 结构归属**：
   - 若是 `ai7proxy` 自身连不上 `opencode.ai` 抛出的 502，格式固定为 `{"error":{"message":"Bad Gateway: Unable to connect to upstream provider.","type":"proxy_error","code":502}}`。
   - 而上述包含 `"workspaceID"`、`"serviceAccountID"`、`"product": "standard" | "go"`、`"attempts"` 的 JSON 是 **OpenCode 官方网关 (`opencode.ai`) 返回的推理遥测事件日志**。
   - 日志中 `"country": "US", "region": "California", "city": "Los Angeles"` 以及完整的 `requestHeaders` 直接证明：**`ai7proxy` 已 100% 成功剥离客户端真实 IP，并将请求与认证标头完整无损地送达了 `opencode.ai`！**
2. **看 `attempts` 中的 `30113ms`（30.1 秒）耗时特征**：
   - 不管走 Zen (`/inference/v1`) 还是 Go (`/inference/go/v1`)，`cat-jam-free` 在 `opencode.ai` 内部都指向同一个免费匿名测试算力池（Stealth Model）。
   - 当客户端携带约 26KB 的 Agent 工具上下文并开启 `"reasoningEffort": "max"` 或 `"high"` 时，免费算力节点因排队过载无法在 **OpenCode 官方网关内部硬编码的 30 秒首包限时（`30113ms` / `30102ms`）** 内吐出首包，被 `opencode.ai` 内部超时斩断并重试失败，最终向客户端返回 `502 inference_failed`。

#### 解决方案：
- **无需修改 `ai7proxy` 代码或代理配置**；
- **方案 A**：将该免费测试模型的思考强度从 `max`/`high` 调低至 `low` 或 `medium`（避免触发 `opencode.ai` 内部对免费节点的 30 秒首包斩断）；
- **方案 B（推荐）**：直接切换至上游算力充沛稳定的模型（如免费模型中的 `opencode/nemotron-3-ultra-free`、`opencode/muse-spark-1.3-contributor-free`，或 `opencode-go/` 订阅通道下的 `kimi-k3`、`glm-5.3`、`deepseek-v4-pro`、`minimax-m3` 等正式商业模型）。

---

### 实战案例三：测试 OpenCode 免费模型时，为何 `curl` 裸请求返回 `403 FreeTierError`，而通过 OpenCode CLI 却能正常免费调用？

#### 核心机制解析：
OpenCode V2 对不同类型的免费模型实施了分级的防滥用校验策略：
1. **SystemOne 决策模型 (`jev-1.13-free`)**：
   - 位于专用端点 `POST /opencode/inference/v1/systemone`，无需 Authorization 即可直接通过 `curl` 调用并返回 `200 OK` 决策 JSON。
2. **对话/Agent 免费模型 (`cat-jam-free`、`muse-spark-1.3-contributor-free`、`nemotron-3-ultra-free`)**：
   - 若不带付费 API Key 直接用 `curl` 裸调 `/opencode/inference/v1/chat/completions` 或 `/responses`，`opencode.ai` 会拦截并返回 `403 FreeTierError: Free tier requires OpenCode CLI. Authenticate with a paid API key for direct API access.`。
   - **正确免 Key 端到端测试方法**：在合规出口服务器或通过 `ai7proxy` 代理注入 `OPENCODE_CONFIG_CONTENT`，使用官方 CLI 发起非交互式调用：
     ```bash
     OPENCODE_CONFIG_CONTENT='{"providers":{"opencode":{"settings":{"baseURL":"http://127.0.0.1:7749/opencode/inference/v1"}}}}' \
       opencode run --standalone --model opencode/nemotron-3-ultra-free "Reply with ONLY: PONG" < /dev/null
     ```

---

### 实战案例四：在 OpenCode v2.1.2+ 中只配置了 `opencode-go` 的顶层 `baseURL`，为何调用 `gpt-6-luna` 提示 `Country, region, or territory not supported`、调用 `beam-free` 返回 `403 Rejected`（日志显示 `country: "CN"`），而 `grok-4.7` 和 `claude-haiku-5-5` 却返回 `200`？

#### 现象再现（四份后台日志对比）：
在 `opencode.jsonc` 中仅配置了 `"opencode-go": { "settings": { "baseURL": "https://your-domain.com/opencode/inference/go/v1" } }`（未声明 `models`），分别调用四个模型后，后台日志均显示 `"country": "CN"`，且 `path` 分别为：
- `grok-4.7` (`/inference/go/openai/v1/responses`) -> `200 succeeded` (`attemptCount: 1`)
- `claude-haiku-5-5` (`/inference/go/anthropic/v1/messages`) -> `200 succeeded` (`attemptCount: 1`)
- `beam-free` (`/inference/go/openai/v1/chat/completions`) -> `403 rejected` (`attemptCount: 0`, `durationMs: 25`)
- `gpt-6-luna` (`/inference/go/openai/v1/responses`) -> `403 failed` (`attemptCount: 1`, `durationMs: 2`, `[unsupported_country_region_territory] Country, region, or territory not supported`)

#### 深度原因剖析：
1. **为什么日志显示 `country: "CN"` 且 `path` 带有 `/openai/`、`/anthropic/`？**
   - 在 OpenCode v2.1.2+ 的最新官方目录（`models.opencode.ai/api.json`）中，跨协议族服务商 `"opencode"` 与 `"opencode-go"` 在**每一个模型对象内部都单独定义了 `model.provider.api`**（加载后转化为模型级 `model.settings.baseURL`，如 `https://opencode.ai/inference/go/openai/v1`）。
   - OpenCode 在 `Model.snapshot` 中执行 `xs(provider.settings, model.settings)` 合并配置时，**模型级 `model.settings.baseURL` 优先级高于服务商顶层 `provider.settings.baseURL`**。
   - 因此，若不在 `models` 下覆写模型级 `baseURL`，这四个模型的请求**实际上全部绕过了 `ai7proxy`，由国内客户端直连了 `https://opencode.ai`**！
2. **为什么本机直连 `opencode.ai` 时，Grok 与 Haiku 成功（200），而 Beam 与 Luna 失败（403）？**
   - `opencode.ai` 托管在 Cloudflare 上，国内可直连握手；转发 `grok-4.7` 和 `claude-haiku-5-5` 时未拦截 `CN` 来源 IP，因此直连也返回 `200 OK`（造成“代理已生效”的错觉）。
   - `beam-free` 官方明确限制中国地区（含港澳）访问，`opencode.ai` 边缘网关检测到 `country: "CN"` 后在 25ms 内直接拒绝（`outcome: "rejected"`, `attemptCount: 0`）。
   - `gpt-6-luna` 为 OpenAI 模型，直连暴露 `CN` 地区后在 2ms 内触发 OpenAI 上游地区风控（`403 Country, region, or territory not supported`）。

#### 权威验证与根治方案：
1. **在 `opencode.jsonc` 的 `"opencode"` 与 `"opencode-go"` 下显式配置 `models.<id>.settings.baseURL`**（见 4.2 节标准模板），仅覆盖 `settings.baseURL`，模型自带的 `package`、`variants`、`capabilities` 与 `limit` 均100%保留。
2. **验证生效**：执行 `opencode api model.list`，确认目标模型的 `settings.baseURL` 已变为 `https://your-domain.com/opencode/inference/...`，此时调用 `gpt-6-luna` 与 `beam-free` 均通过海外代理节点返回 `200 OK`。
