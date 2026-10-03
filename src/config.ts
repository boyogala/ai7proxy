export interface ProxyTarget {
  pathSegment: string;
  target: string;
  orHostname?: string;
  /** 可为特定服务商定制默认超时（毫秒），统一基准为 900,000ms (15分钟) */
  timeout?: number;
}

export const DEFAULT_TIMEOUT_MS = 900_000; // 统一 15 分钟

export const PROXIES: ProxyTarget[] = [
  // 1. Google AI (Gemini & CloudCode)
  {
    pathSegment: "generativelanguage",
    orHostname: "gooai.chatkit.app",
    target: "https://generativelanguage.googleapis.com",
    timeout: DEFAULT_TIMEOUT_MS,
  },
  {
    pathSegment: "googleapis-cloudcode-pa",
    target: "https://cloudcode-pa.googleapis.com",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 2. OpenAI (GPT-4o, o1, o3, o4 series)
  {
    pathSegment: "openai",
    target: "https://api.openai.com",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 3. Anthropic (Claude 3.5, Claude 3.7 Sonnet Thinking series)
  {
    pathSegment: "anthropic",
    target: "https://api.anthropic.com",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 4. OpenCode V2 (Official Gateway, Console, and Zen / Go Endpoints)
  {
    pathSegment: "opencode",
    target: "https://opencode.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 5. OpenRouter
  {
    pathSegment: "openrouter/api",
    target: "https://openrouter.ai/api",
    timeout: DEFAULT_TIMEOUT_MS,
  },
  {
    pathSegment: "openrouter",
    target: "https://openrouter.ai/api",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 6. xAI (Grok)
  {
    pathSegment: "xai",
    target: "https://api.x.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 7. Groq
  {
    pathSegment: "groq",
    target: "https://api.groq.com",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 8. Perplexity
  {
    pathSegment: "pplx",
    target: "https://api.perplexity.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 9. Mistral
  {
    pathSegment: "mistral",
    target: "https://api.mistral.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  },

  // 10. Cerebras
  {
    pathSegment: "cerebras",
    target: "https://api.cerebras.ai",
    timeout: DEFAULT_TIMEOUT_MS,
  },
];

/**
 * 构建快速路由查找表：
 * 按第一段路径分组（例如 "openai", "anthropic", "opencode" 等），
 * 使得分发查找在绝大多数情况下为 O(1)，互不影响且无多余遍历开销。
 */
export class ProxyRouter {
  private routeMap = new Map<string, ProxyTarget[]>();
  private hostnameMap = new Map<string, ProxyTarget>();

  constructor(proxies: ProxyTarget[]) {
    // 按照 pathSegment 长度降序排序，确保更长、更精确的前缀（如 "openrouter/api"）优先于短前缀（"openrouter"）匹配
    const sorted = [...proxies].sort((a, b) => b.pathSegment.length - a.pathSegment.length);

    for (const p of sorted) {
      const firstSegment = p.pathSegment.split("/")[0];
      const list = this.routeMap.get(firstSegment) ?? [];
      list.push(p);
      this.routeMap.set(firstSegment, list);

      if (p.orHostname) {
        this.hostnameMap.set(p.orHostname, p);
      }
    }
  }

  find(pathname: string, hostname: string): { proxy: ProxyTarget; matchedPrefix: string } | null {
    // 1. 优先检查域名直连映射
    if (this.hostnameMap.has(hostname)) {
      const proxy = this.hostnameMap.get(hostname)!;
      return { proxy, matchedPrefix: "" };
    }

    // 2. 提取 pathname 的第一段（例如 /openai/v1/... -> openai）
    const trimmedPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;
    const firstSegment = trimmedPath.split("/")[0];

    const candidates = this.routeMap.get(firstSegment);
    if (!candidates) {
      return null;
    }

    // 3. 在候选规则中匹配（候选通常只有 1~2 项，开销极小且彼此隔离）
    for (const p of candidates) {
      const prefix = `/${p.pathSegment}`;
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        return { proxy: p, matchedPrefix: prefix };
      }
    }

    return null;
  }
}

export const proxyRouter = new ProxyRouter(PROXIES);
