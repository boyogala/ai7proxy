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
6. [零跳步打包、传输与生产部署流水线](#6-零跳步打包传输与生产部署流水线)
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
每次请求新建连接会产生严重的 TLS 握手开销（多轮 RTT，约 150ms ~ 300ms）。
- **最佳实践**：引入 Node.js 官方底层的 `undici.Agent`：
  ```ts
  import { Agent } from "undici";

  export const proxyAgent = new Agent({
    keepAliveTimeout: 60_000,        // 60秒空闲保活
    keepAliveMaxTimeout: 600_000,    // 最长连接生命周期 10分钟
    pipelining: 1,                   // 严格保障请求时序
    connect: { timeout: 30_000 },    // TCP 建连超时 30秒
  });
  ```
  请求通过 `dispatcher: proxyAgent` 派发，后续同一厂商的并发请求直接复用已建立的 TLS 隧道，握手延迟降至 **~0ms**。

### 2.3 统一 15 分钟（900s）长推理超时机制
- 废弃 60s 硬编码限制，将全局基准超时设置为 `900,000ms`（15分钟）；
- 兼容各大厂商与自定义客户端的动态请求头覆盖：检测客户端传入的 `x-proxy-timeout`（毫秒），支持会话级自定义长超时。

### 2.4 RFC 规范与流式传输（SSE 直通）
- **请求体清洗**：
  ```ts
  const isBodyAllowed = req.method !== "GET" && req.method !== "HEAD";
  const body = isBodyAllowed ? req.body : undefined;
  ```
  从根源上杜绝 Node.js 运行时由于 GET 携带 Body 抛出的 `TypeError`。
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

### 4.1 统一端点路由设计
OpenCode v2 拥有全套控制台、模型网关以及 Zen/Go 代码补全端点。
- **设计标准**：放弃碎片化别名，维护唯一定义：
  ```ts
  {
    pathSegment: "opencode",
    target: "https://opencode.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  }
  ```
  自动透明支持：
  - 官方网关：`https://your-domain.com/opencode/...` -> `https://opencode.ai/...`
  - 精选编码模型 (Go)：`https://your-domain.com/opencode/zen/go/v1` -> `https://opencode.ai/zen/go/v1`

### 4.2 客户端标准配置模板 (`opencode.jsonc`)
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
    }
  }
}
```

### 4.3 核心机制真相：“给出具体模型” vs “不给出具体模型”
很多开发者对该配置存在严重误解，智能体应向使用者清晰阐明底层逻辑：

| 配置策略 | 声明方式 | 行为逻辑与可用范围 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **不给具体模型** *(强烈推荐)* | 只配置 `baseURL` + `apiKey`，**不写 `models: {}`** | **该服务商官方开放的所有可用模型全部直接可用！** 客户端会自动继承 OpenCode 内置官方目录（`models.dev`）。敲 `/models` 官方最新全量模型全选可用。 | **日常开发最佳实践**。零维护成本，官方发布新模型无需修改配置即可直接使用。 |
| **显式给出具体模型** | 显式声明 `models: { "model-id": { ... } }` | **增量覆盖/定制模式**。用于自定义尚未收录的模型、指定专属 Token 上限、或设置 `"disabled": true` 隐藏特定高消费模型。 | 接入内测模型、团队权限成本管控、或为特定模型锁定 `#high` 思考档位。 |

> ⚠️ **重要认知**：`ai7proxy` 仅为高性能透明管道，**绝不会限制或裁剪任何模型名称**。推理思考（Thinking）、图片/PDF 多模态及工具调用（Tools）全部在客户端与官方之间天然透传，日常无需手动重写 `capabilities`。

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
3. **全局快捷方式软链接**：
   自动将脚本软链接至 `/usr/local/bin/proxy2ai`，赋予全局调用能力。

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

## 6. 零跳步打包、传输与生产部署流水线

### 第一步：本地安全打包（严格排除垃圾文件）
在源码目录执行打包，必须排除 `node_modules/` 与编译产物：
```bash
# Windows PowerShell
Compress-Archive -Path src, test, package.json, package-lock.json, tsconfig.json, proxy2ai, proxy2ai.sh, Dockerfile, README.md, .gitignore -DestinationPath ai7proxy.zip -Force
```

### 第二步：本地终端一键上传至 VPS
无需任何第三方 GUI 工具，直接使用系统内置原生 `scp` 命令：
```bash
scp ai7proxy.zip root@<你的VPS_IP>:/root/
# 若 SSH 端口非默认 22，添加大写 -P 参数：
# scp -P 2222 ai7proxy.zip root@<你的VPS_IP>:/root/
```

### 第三步：登录 VPS 规范解压至 `/opt/ai7proxy`
```bash
# 1. 登录 VPS
ssh root@<你的VPS_IP>

# 2. 安装解压依赖并创建标准目录
apt-get update -y && apt-get install -y unzip
mkdir -p /opt/ai7proxy

# 3. 静默覆盖解压
unzip -o /root/ai7proxy.zip -d /opt/ai7proxy

# 4. 进入目录赋权并一键启动
cd /opt/ai7proxy
chmod +x proxy2ai
./proxy2ai
```

### 第四步：后续代码热更新流程（极简 3 步）
1. 本地打包上传：`scp ai7proxy.zip root@<VPS_IP>:/root/`
2. VPS 静默覆盖解压：`unzip -o /root/ai7proxy.zip -d /opt/ai7proxy`
3. VPS 极速热重启：`proxy2ai restart`

---

## 7. Git 历史深度脱敏与安全开源标准

在开源或将代码推送到 GitHub 时，安全风控与敏感信息泄露防范是重中之重：

### 7.1 本地静态扫描三原则
在提交前必须对全项目目录执行正则深度检索：
- **域名敏感扫描**：确保无任何包含个人测试域名（如 `ai7proxy.894900.xyz`）的遗留，全部替换为标准范例域名（`https://your-domain.com`）；
- **公网 IP 扫描**：确保无任何真实物理云机房公网 IP，仅允许出现 `127.0.0.1` 及测试 Mock 假 IP；
- **API Key 扫描**：确保无任何 `sk-` 等真实密钥，必须使用 `{env:VARIABLE_NAME}` 占位。

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

### 实战案例：调用 Google Gemini 提示 `User location is not supported`，但探测连通性却返回 `HTTP/2 404`？

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
