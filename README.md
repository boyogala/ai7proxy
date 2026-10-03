# ai7proxy

**`ai for proxy` 的第 7 个版本啊，真的很费钱呢**

`ai7proxy` 是在原有 [ai-proxy](https://github.com/egoist/ai-proxy) 基础上深度优化、全面重构与功能扩充的高性能透明代理服务。全面适配最新主流 AI 厂商（OpenAI、Anthropic、Google Gemini、OpenRouter、xAI Grok 等）以及最新 **OpenCode **官方 API 服务。

---

## 🌟 核心特性与架构升级

| 特性 | ai-proxy（旧版缺陷） | ai7proxy（重构优化后） |
| :--- | :--- | :--- |
| **路由分发架构** | `Array.find()` 每次请求 O(N) 线性遍历 | **O(1) Radix 前缀哈希分发**，各服务商独立隔离，互不影响 |
| **网络性能与延迟** | 每次使用临时连接，重复 TLS 握手 (+200ms) | **Undici Agent Keep-Alive 连接池复用**，握手延迟直接降至 ~0ms |
| **现代推理长思考模型** | 60s 硬编码超时，o1/o3/Claude 3.7 Thinking 频繁断连 (504) | **统一 15 分钟 (900s) 长超时**，支持 `X-Proxy-Timeout` 动态覆盖 |
| **HTTP 标准规范** | GET/HEAD 时强传 body，Node.js 运行时抛出 `TypeError` 崩溃 | **严格遵循 RFC 与 Fetch 规范**，自动屏蔽 GET/HEAD Body |
| **请求头清洗与透传** | 仅简单过滤 `cf-` 等，遗留 Hop-by-hop 头部风险 | **全面清洗 Hop-by-hop 标头**，保留各厂商关键授权与业务标头 |
| **OpenCode v2 支持** | ❌ 不支持 | ✅ **全面透明代理 OpenCode v2 与 OpenCode Go/Zen 端点** |
| **流式传输体验** | 普通转发 | **零拷贝 Web Streams 直通**，保留 `X-Accel-Buffering: no` 保证即时打字机效果 |

---

## 🚀 支持的服务商与透明路由映射

| AI 服务商 | 代理请求路径示例 | 映射到的官方真实地址 |
| :--- | :--- | :--- |
| **OpenCode v2 (全功能端点)** | `https://your-proxy:7749/opencode/...` | `https://opencode.ai/...` |
| **OpenAI** | `https://your-proxy:7749/openai/v1/...` | `https://api.openai.com/v1/...` |
| **Anthropic** | `https://your-proxy:7749/anthropic/v1/...` | `https://api.anthropic.com/v1/...` |
| **Google Gemini** | `https://your-proxy:7749/generativelanguage/v1beta/...` | `https://generativelanguage.googleapis.com/v1beta/...` |
| **Google CloudCode** | `https://your-proxy:7749/googleapis-cloudcode-pa/...` | `https://cloudcode-pa.googleapis.com/...` |
| **OpenRouter** | `https://your-proxy:7749/openrouter/v1/...` | `https://openrouter.ai/api/v1/...` |
| **xAI (Grok)** | `https://your-proxy:7749/xai/v1/...` | `https://api.x.ai/v1/...` |
| **Groq** | `https://your-proxy:7749/groq/openai/v1/...` | `https://api.groq.com/openai/v1/...` |
| **Perplexity** | `https://your-proxy:7749/pplx/...` | `https://api.perplexity.ai/...` |
| **Mistral** | `https://your-proxy:7749/mistral/...` | `https://api.mistral.ai/...` |
| **Cerebras** | `https://your-proxy:7749/cerebras/...` | `https://api.cerebras.ai/...` |

---

## 🛠️ 在 OpenCode v2 客户端中配置使用

在你的项目根目录或全局 `opencode.jsonc` 配置文件中接入代理服务。以下是涵盖主流 AI 服务商代理地址（`baseURL`）与密钥（`apiKey`）的完整配置范例：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "providers": {
    // 1. Anthropic (Claude 3.5 / 3.7 Sonnet Thinking 系列)
    "anthropic": {
      "settings": {
        "baseURL": "https://your-domain.com/anthropic",
        "apiKey": "{env:ANTHROPIC_API_KEY}"
      }
    },

    // 2. OpenAI (GPT-4o, o1, o3-mini 系列)
    "openai": {
      "settings": {
        "baseURL": "https://your-domain.com/openai/v1",
        "apiKey": "{env:OPENAI_API_KEY}"
      }
    },

    // 3. Google Gemini (Gemini 2.0 / 2.5 Flash & Pro)
    "google": {
      "settings": {
        "baseURL": "https://your-domain.com/generativelanguage",
        "apiKey": "{env:GEMINI_API_KEY}"
      }
    },

    // 4. xAI (Grok 系列)
    "xai": {
      "settings": {
        "baseURL": "https://your-domain.com/xai",
        "apiKey": "{env:XAI_API_KEY}"
      }
    },

    // 5. OpenRouter (汇聚全球主流大模型网关)
    "openrouter": {
      "settings": {
        "baseURL": "https://your-domain.com/openrouter",
        "apiKey": "{env:OPENROUTER_API_KEY}"
      }
    },

    // 6. OpenCode Go (OpenCode 官方高性价比精选编码模型)
    "opencode-go": {
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": {
        "baseURL": "https://your-domain.com/opencode/zen/go/v1",
        "apiKey": "{env:OPENCODE_API_KEY}"
      }
    }
  }
}
```

---

### 🔑 1. API-KEY 的配置方式详解

OpenCode 支持以下三种凭证录入方式，推荐采用第 ① 种（最安全、防代码泄漏）：

1. **环境变量引用语法 `{env:VARIABLE_NAME}`（强烈推荐）**：
   在配置文件中写入 `"apiKey": "{env:OPENAI_API_KEY}"`，然后在操作系统环境变量或 `.env` 文件中设置 `OPENAI_API_KEY=sk-...`。这样能避免 API 密钥明文写入代码库，降低秘钥泄漏风险。
2. **直接填写明文密钥**：
   也可以直接赋值明文字符串：`"apiKey": "sk-your-real-key-here"`（仅建议在个人安全环境测试时使用）。
3. **命令行交互式绑定 `/connect`**：
   直接在 OpenCode 终端中运行 `/connect` 指令，选定服务商后粘贴密钥，密钥将保存在本机的安全凭据存储中，无需在 jsonc 文件中显式配置 `apiKey`。

---

### 🧠 2. 配置中“给出具体模型”与“不给出具体模型”的核心区别

在 `opencode.jsonc` 的服务商配置中，是否声明 `models: { ... }` 列表具有截然不同的行为逻辑，具体区别如下：

#### 情况 A：不给出具体模型（不声明 `models` 字段，推荐日常使用）
- **行为表现**：
  OpenCode 对内置官方服务商（如 `openai`、`anthropic`、`google`、`xai`、`openrouter`）内置了官方完整的模型目录（来源于社区维护的 `models.dev` 元数据数据库）。
- **可用范围**：
  **客户端可以直接使用该 AI 服务商官方开放的所有可用模型！**
  只要在终端中执行 `/models`，官方目录中收录的所有最新模型（如 `gpt-4o`、`o1`、`o3-mini`、`claude-3-7-sonnet` 等）**全部可见、全部可选**。
- **透明代理的作用**：
  `ai7proxy` 仅作为一个纯透明的数据通道，负责将请求地址重定向至代理节点并清洗网络特征，**不会限制或裁剪任何模型名称**。官方出了什么新模型，只要官方 API 支持，无需修改任何代理配置即可直接使用。

#### 情况 B：给出具体模型（在配置中显式声明 `models: { ... }`）
- **行为表现**：
  在已有的官方服务商下声明 `models`，属于**增量定制（Override / Add）模式**，而不是排他性白名单模式。它主要用于以下三种场景：
  1. **接入官方目录尚未收录的新模型或私有微调模型**：
     例如服务商刚刚内测了某个新模型 `gpt-5-preview`，官方 catalog 尚未收录，你可以手动追加：
     ```jsonc
     "openai": {
       "settings": { "baseURL": "https://your-domain.com/openai/v1" },
       "models": {
         "gpt-5-preview": {
           "name": "GPT-5 Preview"
         }
       }
     }
     ```
  2. **为特定模型定制专属参数或请求头**：
     例如希望对某个具体模型开启特定的思考预算、调整上下文限制或增加网关租户标头。
  3. **显式禁用特定模型**：
     如果你希望团队成员不能在界面上选择某个昂贵的模型，可以设置 `"disabled": true` 将其从 `/models` 列表中剔除：
     ```jsonc
     "models": {
       "expensive-model": { "disabled": true }
     }
     ```
- **注意区分自定义服务商（Custom Providers）**：
  如果你不是使用内置的 `openai`/`anthropic`，而是自己命名了一个全新的服务商 ID（如 `"my-company-ai"` 且没有继承 `canonical`），此时由于没有预设的官方目录，**必须显式给出具体的 `models` 列表**，否则客户端将无法获知有哪些模型可供选择。

---

### 3. 最小配置能做什么，以及哪些字段不要写

下面这段就是一份可用的 Google 配置。OpenAI、Anthropic、xAI、OpenRouter 的最小配置也只有这两项：`baseURL` 和 `apiKey`。

```jsonc
"google": {
  "settings": {
    "baseURL": "https://your-domain.com/generativelanguage",
    "apiKey": "{env:GEMINI_API_KEY}"
  }
}
```

它只做两件事：

1. `baseURL` 把 OpenCode 内置 `google` 服务商的请求地址，从 Google 官方地址改到本代理。代理再原样转到 `https://generativelanguage.googleapis.com`。密钥不会写进代理，代理只转发客户端已经带上的请求头和查询参数。
2. `apiKey` 把本机环境变量 `GEMINI_API_KEY` 交给 OpenCode 的 Google 运行时。运行时自己把它放进 `x-goog-api-key` 或官方要求的查询参数。代理不读取这个环境变量。

使用前必须先在启动 OpenCode 的那个终端里设置变量，否则 `{env:GEMINI_API_KEY}` 解析出来是空的，请求会以 401 或 403 失败：

```bash
export GEMINI_API_KEY="你的 Google AI Studio 密钥"
```

Windows PowerShell：

```powershell
$env:GEMINI_API_KEY = "你的 Google AI Studio 密钥"
```

#### 不写推理等级、input、output 时，实际得到什么

不写这些字段，不是“功能被关掉”，而是继续使用 OpenCode 自带目录里的原值。目录来自 [models.dev](https://models.dev)，随 OpenCode 客户端更新，不由 `ai7proxy` 提供或修改。

| 你没写的字段 | 实际使用的值 | 结果 |
| --- | --- | --- |
| `models` | 内置 `google` 目录里已启用的模型 | `/models` 里能看到目录中的 Google 模型，不是只能用某一个 |
| `model`（文件最外层） | 未指定时，OpenCode 在可用模型里选一个；已打开的会话保持你上次选的模型 | 这段配置不会把默认模型改成某个 Gemini |
| 推理等级 / `variants` | 该模型目录里已经声明的档位，例如有的模型有 `low`、`high` | 不写配置也能推理。要换档位时，在选择模型时加 `#档位`，例如 `google/模型ID#high`。目录里没有的档位会报模型解析错误，不要自己编档位名 |
| `capabilities.input` / `capabilities.output` | 目录里该模型声明的输入、输出类型，例如文本、图片 | 客户端按目录决定能不能发图片、能不能收文本。代理不检查、不改写这些类型 |
| `limit.context` / `limit.output` | 目录里该模型的上下文和输出上限 | 客户端按目录裁剪过长上下文。这不是 Google 接口本身的硬限制，写错会让客户端提前截断 |
| 工具调用 | 目录里该模型的 `tools` 能力 | 目录标明支持工具时，编码代理可以调用工具。代理只转发，不实现工具 |

所以，日常使用不要在这段配置里再补推理等级、input、output。补进去的值会覆盖目录原值。覆盖错了，表现是客户端拒绝图片、禁用工具，或把上下文截短，而不是代理变快。

`ai7proxy` 不读取、不执行这些字段。请求体里的模型名、思考参数、图片，都是 OpenCode 生成后原样转发。

#### 这段配置做不到的事

- 不会自动选定某一个 Gemini 模型。要固定默认模型，在文件最外层另写一行，模型 ID 以你本机 `/models` 里显示的为准，不要照抄过期示例：

  ```jsonc
  {
    "model": "google/这里填 /models 里看到的 ID"
  }
  ```

- 不会打开目录里没有的模型。目录没有的 ID，必须按上一节“情况 B”手动加入 `models`。
- 不会改 Google 账号的配额、计费或地区限制。这些仍由 Google 和 `GEMINI_API_KEY` 决定。
- 不会让代理保存密钥。换机器后要在新机器上重新设置 `GEMINI_API_KEY`，或重新执行 `/connect`。

#### 只有下面这种情况下，才写 input、output 和 limit

内置目录里已经有的模型，不要写。只有你手动添加一个目录里没有的模型，而且没有继承官方目录时，OpenCode 才会使用它自己的兜底假设，而不是去问 Google：

- 工具：开启
- 输入：文本和图片
- 输出：文本
- 上下文：200000
- 输出上限：32000

这些是客户端假设，不是该模型的真实能力。已知真实值时再写，未知就不要编：

```jsonc
"google": {
  "settings": {
    "baseURL": "https://your-domain.com/generativelanguage",
    "apiKey": "{env:GEMINI_API_KEY}"
  },
  "models": {
    "目录里没有的模型ID": {
      "name": "显示名称",
      "capabilities": {
        "tools": true,
        "input": ["text", "image"],
        "output": ["text"]
      },
      "limit": {
        "context": 1048576,
        "output": 65536
      }
    }
  }
}
```

这里的数字只是“你已经查过该模型文档”之后才填写的例子。没查过就不要填，否则客户端会按错误上限工作。

#### 地址里要不要带 `/v1beta`

Google 生成式接口的正式路径在 `/v1beta` 下，例如 `/v1beta/models/...:generateContent`。OpenCode 的 Google 运行时可能把 `/v1beta` 放在默认 `baseURL` 里，也可能在 `baseURL` 后面自己追加。公开文档没有给出这个包的默认字符串，所以不要猜，用一次真实请求确认：

1. 先用上面的最小配置发一条 Google 请求。
2. 在 VPS 上执行 `proxy2ai log`，看转发后的路径。
3. 路径里已经有 `/v1beta/models/`：当前 `baseURL` 正确，不要改。
4. 路径是 `/models/` 且没有 `v1beta`，或 Google 返回路径错误：把 `baseURL` 改成 `https://your-domain.com/generativelanguage/v1beta` 后再试一次。

改的是客户端配置，不是代理代码。代理两种路径都能转发。

---

## 📦 部署与运行

### 1. Linux (Debian / Ubuntu) 一键极简部署（生产环境强烈推荐）

以下为**从本地电脑上传源码包到 VPS，规范解压到 `/opt/ai7proxy` 并一键常驻启动**的全流程无跳步指南：

#### 第一步：在本地电脑将 `ai7proxy.zip` 上传到 VPS
Windows（PowerShell）或 macOS / Linux 终端均内置原生 `scp` 命令，无需额外安装软件。打开本地终端执行：

```bash
# 将 <你的VPS_IP> 替换为 VPS 的真实公网 IP 地址
scp ai7proxy.zip root@<你的VPS_IP>:/root/
```
> 💡 *若 VPS 的 SSH 端口非默认 22（如 2222），需加入大写 `-P` 参数：`scp -P 2222 ai7proxy.zip root@<你的VPS_IP>:/root/`*

#### 第二步：登录 VPS 并规范解压至 `/opt/ai7proxy`
1. SSH 登录您的 VPS：
   ```bash
   ssh root@<你的VPS_IP>
   ```
2. 安装解压工具并创建目标安装目录：
   ```bash
   apt-get update -y && apt-get install -y unzip
   mkdir -p /opt/ai7proxy
   ```
3. 将压缩包静默覆盖解压到 `/opt/ai7proxy`：
   ```bash
   unzip -o /root/ai7proxy.zip -d /opt/ai7proxy
   ```

#### 第三步：进入目录并执行一键安装部署
```bash
cd /opt/ai7proxy
chmod +x proxy2ai
./proxy2ai
```

- **全自动化接管**：脚本会自动检测并安装 Node.js 22 LTS、自动安装 npm 依赖、自动编译 TypeScript，并将服务注册为 `systemd` 后台系统服务与开机自启。
- **全局管理指令**：安装后在系统任意目录下可直接输入：
  - `proxy2ai`：查看运行状态或一键安装
  - `proxy2ai status`：查看 systemd 后台常驻状态
  - `proxy2ai log`：查看实时转发日志
  - `proxy2ai stop`：关闭后台服务
  - `proxy2ai restart`：一键重新编译并热重启
  - `proxy2ai uninstall`：彻底卸载服务并清除全部项目文件，不留任何系统痕迹

#### 附：后续日常代码热更新（仅需 3 步）
若日后在本地修改了代理代码并重新打包：
1. 本地上传：`scp ai7proxy.zip root@<VPS_IP>:/root/`
2. VPS 解压：`unzip -o /root/ai7proxy.zip -d /opt/ai7proxy`
3. VPS 重启：`proxy2ai restart`（仅需 2 秒即可完成自动重新编译与热加载）

---

### 2. Docker 部署

```bash
docker build -t ai7proxy .
docker run -d --restart unless-stopped -p 7749:7749 --name ai7proxy ai7proxy
```

---

### 3. 本地 Node.js 手动运行

```bash
cd ai7proxy
npm install
npm run build
npm start
```
服务默认监听在 `http://localhost:7749`（可通过环境变量 `PORT` 或 `WEB_PORT` 覆盖）。

---

### 4. 自动化测试

```bash
npm test
```
包含路由隔离、URL 规范重写、GET/HEAD Body 过滤、SSE 流式、长超时等 11 项全套自动化测试。

---

## ❓ 常见问题排查 (FAQ)

### Q1: 调用 Google Gemini API 提示 `Error: User location is not supported for the API use`，或访问 Google AI Studio 提示 `Failed to list models: permission denied. Please try again.`？

- **根本原因**：
  **这绝不是 ai7proxy 项目本身或代码的故障，而是部署该代理的 VPS 服务器的出站 IP 地址（物理机房 IP）不在 Google 等 AI 服务商支持的地区名单内，或被识别为受限制的机房/广播 IP。**

  `ai7proxy` 在底层架构设计上严格清洗并剔除了客户端发来的 `cf-connecting-ip`、`x-forwarded-for` 和 `x-real-ip` 等客户端 IP 标头（以防止客户端真实物理地址泄露）。因此，Google、OpenAI、Anthropic 等上游服务商在进行地区合规（Geo-blocking）与安全风控检测时，**直接依据的是你部署代理的这台 Linux VPS 服务器本身的出口公网 IP**。如果这台 VPS 的 IP 属于不受官方支持的国家/地区（如中国大陆、中国香港大部分云厂商机房 IP 等），Google API 会直接在业务层拒绝请求并返回该错误。

- **实战案例深度解析（网友常见排查误区）**：
  有网友在 VPS 终端执行基础连通性探测时，发现返回如下信息：
  ```text
  root@VM-xxxx:~# curl -I https://generativelanguage.googleapis.com
  HTTP/2 404
  date: Sat, 03 Oct 2026 04:56:08 GMT
  content-type: text/html; charset=UTF-8
  server: scaffolding on HTTPServer2
  content-length: 1561
  ...
  ```
  **很多开发者看到 `HTTP/2 404` 往往会误以为是“域名输入错误”、“域名挂了”或“网络不通”，这是极其普遍的认知误区！**
  1. **网络传输层层面（物理链路 100% 畅通）**：
     能收到 `HTTP/2 404` 以及 `server: scaffolding on HTTPServer2`（Google 官方接入网关代号），说明 **VPS 到 Google 官方服务器的底层 TCP 路由与 TLS 443 端口握手完全通畅，没有任何物理网络阻断**；
  2. **为什么会返回 404？**
     因为 Google 生成式 API 的根路径 `/` 本身就没有挂载任何网页或 index 资源，Google 接入层网关对根路径探测默认就是响应 404，这是完全正常的官方行为；
  3. **真正的限制发生在 API 业务逻辑层**：
     当请求带有具体合法的 API 端点（例如获取模型列表或生成对话）时，Google 业务网关才会校验请求发起者的出口 IP 物理地域归属。一旦判定 IP 来自未获支持的地区（如香港云机房），便会立即拦截并返回如下标准风控错误：
     ```json
     {
       "error": {
         "code": 403,
         "message": "User location is not supported for the API use.",
         "status": "FAILED_PRECONDITION"
       }
     }
     ```

- **精准排查与验证三步法**：
  1. **检查当前 VPS 的公网 IP 物理归属**：
     ```bash
     curl -s https://ipinfo.io/json
     ```
     查看 `country`（国家）和 `org`（机房服务商）。若显示为 `HK`（香港）或部分国内云厂商的海外机房广播段，Google 往往严格限制。
  2. **在 VPS 终端发起一次真实的 API 业务请求验证**：
     将你的 API 密钥代入以下命令在 VPS 终端直接执行：
     ```bash
     curl -s "https://generativelanguage.googleapis.com/v1beta/models?key=你的GEMINI_API_KEY"
     ```
     - 若返回 `User location is not supported`：实锤该 VPS 出口 IP 触发了 Google 地区合规封锁；
     - 若返回包含各模型 ID 的 JSON 列表：说明该 IP 地区完全合规可用。

- **彻底解决建议**：
  1. **方案 1（首选推荐：选用原生支持地区的 VPS）**：
     将代理部署在 Google 官方明确支持的国家/地区（如：美国、日本、新加坡、韩国、德国、英国等主流合规云数据中心）；
  2. **方案 2（在现有 VPS 上配置 Cloudflare WARP 出站解锁）**：
     若当前 VPS 无法更换，可在这台 VPS 上安装并配置 Cloudflare WARP 免费分流出站流量，将请求 Google / OpenAI 的出站流量经由合规节点转出，即可完美解除该地区限制。

---

## 🛡️ License

MIT License.
