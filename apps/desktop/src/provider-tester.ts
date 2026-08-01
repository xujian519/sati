/**
 * Lightweight provider connectivity tester for the onboarding window.
 *
 * Mirrors the three most critical checks from
 * ui/server/services/providerTester.js but runs inside the Electron main
 * process (before the Sati ui/server starts). Keeps the same result
 * shape so the renderer can display identical UI.
 *
 * Checks performed:
 *   1. network   — HEAD request to baseUrl
 *   2. keyAuth   — POST max_tokens=1 "ping" to the resolved endpoint
 *   3. keyFormat — regex-based advisory hint
 */

const NETWORK_TIMEOUT_MS = 5000;
const API_TIMEOUT_MS = 8000;
const TRUNCATE_BYTES = 240;

export type CheckLevel = "ok" | "warning" | "error" | "skipped";
export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
  durationMs?: number;
}
export interface TestResult {
  endpoint: string;
  overall: CheckLevel;
  checks: Check[];
}

interface ProviderInput {
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function truncate(text: string, max = TRUNCATE_BYTES): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} bytes)`;
}

/** 从错误响应体提取可读消息（兼容 error.message / message 两种形态）。 */
function errorMessage(parsed: Record<string, unknown> | null, body: string): string {
  return (parsed?.error as Record<string, string>)?.message || (parsed?.message as string) || truncate(body, 120);
}

type EndpointMode = "anthropic" | "openai-chat" | "openai-responses" | "google" | "unknown";

// ────────────────────────────────────────────────────────────────────────────
// 端点构造：与 src/model/providerEndpoint.ts buildEndpointCandidates 语义对齐
// 的轻量内联实现。desktop 是独立打包单元（tsconfig rootDir: src），无法直接
// 导入 src/ 源码；修改此处时必须同步核对上游 —— 历史教训：直接拼
// `${baseUrl}/v1/messages` 会造成 "baseUrl 已含 /v1" 时 /v1/v1/ 重复、
// OpenAI 缺 /v1 前缀、google 无分支等三处与运行时判定相反的偏差。
// ────────────────────────────────────────────────────────────────────────────

/** 路径段是否含版本段（v1 / v2 / v1beta…）。 */
function hasVersionSegment(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).pathname
      .split("/")
      .filter(Boolean)
      .some(seg => /^v\d+(?:beta\d*)?$/i.test(seg));
  } catch {
    return false;
  }
}

/** 与 buildEndpointCandidates 一致：endpoint 候选（首个即首选）。 */
function buildEndpointCandidates(baseUrl: string, defaultVersion: string, endpointPath: string): string[] {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const normalizedEndpointPath = endpointPath.replace(/^\/+|\/+$/g, "");
  const candidates: string[] = [];
  const unversioned = `${normalizedBase}/${normalizedEndpointPath}`;
  if (hasVersionSegment(normalizedBase)) {
    candidates.push(unversioned);
  } else {
    candidates.push(`${normalizedBase}/${defaultVersion}/${normalizedEndpointPath}`, unversioned);
  }
  return [...new Set(candidates)];
}

function resolveEndpoint(p: ProviderInput): { url: string; mode: EndpointMode } {
  const baseUrl = stripTrailingSlash(p.baseUrl);
  if (!baseUrl) return { url: "", mode: "unknown" };
  // 大小写归一化：与服务器端一致（"Anthropic"/"OpenAI" 都接受）
  const t = (p.type || "openai-chat").trim().toLowerCase();
  switch (t) {
    case "anthropic":
      return { url: buildEndpointCandidates(baseUrl, "v1", "messages")[0] || "", mode: "anthropic" };
    case "openai-responses":
      return { url: buildEndpointCandidates(baseUrl, "v1", "responses")[0] || "", mode: "openai-responses" };
    case "google": {
      const model = encodeURIComponent(String(p.model || "").replace(/^google\//, ""));
      return {
        url: buildEndpointCandidates(baseUrl, "v1beta", `models/${model}:generateContent`)[0] || "",
        mode: "google",
      };
    }
    default:
      return { url: buildEndpointCandidates(baseUrl, "v1", "chat/completions")[0] || "", mode: "openai-chat" };
  }
}

function buildHeaders(p: ProviderInput, mode: EndpointMode): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (mode === "anthropic") {
    headers["x-api-key"] = p.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else if (mode === "google") {
    headers["x-goog-api-key"] = p.apiKey;
  } else {
    headers["Authorization"] = `Bearer ${p.apiKey}`;
  }
  return headers;
}

function buildPingBody(mode: EndpointMode, modelName: string) {
  if (mode === "anthropic") {
    return { model: modelName, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
  }
  if (mode === "openai-responses") {
    return { model: modelName, max_output_tokens: 1, input: "ping" };
  }
  if (mode === "google") {
    return { contents: [{ role: "user", parts: [{ text: "ping" }] }] };
  }
  return { model: modelName, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyNetworkError(err: unknown): { detail: string; hint: string } {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e?.cause?.code || e?.code || "";
  if (e?.name === "AbortError")
    return { detail: `连接超时 (>${NETWORK_TIMEOUT_MS}ms)`, hint: "检查 baseUrl 是否可达，或网络是否需要代理。" };
  if (code === "ENOTFOUND") return { detail: `DNS 解析失败：${e.message}`, hint: "检查 baseUrl 域名拼写是否正确。" };
  if (code === "ECONNREFUSED")
    return { detail: `连接被拒绝：${e.message}`, hint: "上游服务可能未启动；本地网关请确认端口正确。" };
  if (code === "ECONNRESET") return { detail: `连接被重置：${e.message}`, hint: "可能是 TLS/HTTP 协议不匹配。" };
  return { detail: e?.message || String(err), hint: "" };
}

async function checkNetwork(p: ProviderInput): Promise<Check> {
  const start = Date.now();
  const baseUrl = stripTrailingSlash(p.baseUrl);
  if (!baseUrl) return { id: "network", label: "网络连接", level: "error", detail: "baseUrl 未配置", durationMs: 0 };
  try {
    const res = await fetchWithTimeout(baseUrl, { method: "HEAD" }, NETWORK_TIMEOUT_MS);
    return {
      id: "network",
      label: "网络连接",
      level: "ok",
      detail: `已连通 (HTTP ${res.status})`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    return { id: "network", label: "网络连接", level: "error", detail, hint, durationMs: Date.now() - start };
  }
}

async function checkKeyAuth(p: ProviderInput): Promise<{ compat: Check; auth: Check }> {
  const start = Date.now();
  const { url, mode } = resolveEndpoint(p);
  if (!url) {
    return {
      compat: { id: "apiCompat", label: "API 兼容", level: "error", detail: "无法构造 endpoint（baseUrl 缺失）" },
      auth: { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "前置检查未通过" },
    };
  }

  let res: Response, body: string, parsed: Record<string, unknown> | null;
  try {
    res = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: buildHeaders(p, mode),
        body: JSON.stringify(buildPingBody(mode, p.model)),
      },
      API_TIMEOUT_MS,
    );
    body = await res.text();
    try {
      parsed = body ? JSON.parse(body) : null;
    } catch {
      parsed = null;
    }
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    return {
      compat: { id: "apiCompat", label: "API 兼容", level: "error", detail, hint, durationMs: Date.now() - start },
      auth: { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "API 探测失败" },
    };
  }

  const status = res.status;
  const dur = Date.now() - start;
  const looksLikeLlm =
    parsed && (parsed.error || parsed.choices || parsed.content || parsed.id || parsed.object || parsed.model);
  const modeLabel = mode === "anthropic" ? "Messages API" : mode === "google" ? "generateContent" : mode;

  let compat: Check;
  // 2xx / 401 / 403 / 429 / 4xx 且响应形似 LLM：endpoint 存在（鉴权错误与
  // 限流发生在协议层之后，说明 URL 与请求形状正确）。
  if (status < 500 && (status < 400 || status === 401 || status === 403 || status === 429 || looksLikeLlm)) {
    compat = {
      id: "apiCompat",
      label: "API 兼容",
      level: "ok",
      detail: `支持 ${modeLabel}`,
      durationMs: dur,
    };
  } else if (status === 404 || status === 405) {
    compat = {
      id: "apiCompat",
      label: "API 兼容",
      level: "error",
      detail: `${status}：endpoint 不存在 — ${truncate(body)}`,
      hint: `检查协议类型是否匹配；当前按 ${mode} 调用 ${url}。`,
      durationMs: dur,
    };
  } else if (status >= 500) {
    compat = {
      id: "apiCompat",
      label: "API 兼容",
      level: "error",
      detail: `${status}：上游错误 — ${truncate(body)}`,
      hint: "可能是上游故障，稍后再试。",
      durationMs: dur,
    };
  } else {
    compat = {
      id: "apiCompat",
      label: "API 兼容",
      level: "warning",
      detail: `HTTP ${status} — ${truncate(body)}`,
      durationMs: dur,
    };
  }

  let auth: Check;
  if (status >= 200 && status < 300) {
    auth = { id: "keyAuth", label: "Key 验证", level: "ok", detail: "调用成功 (HTTP 200)" };
  } else if (status === 401 || status === 403) {
    auth = {
      id: "keyAuth",
      label: "Key 验证",
      level: "error",
      detail: `${status} ${status === 401 ? "未授权" : "禁止"}：${errorMessage(parsed, body)}`,
      hint: status === 401 ? "apiKey 无效或已过期。" : "账号无权限访问该模型，或 IP 被限制。",
    };
  } else if (status === 429) {
    auth = { id: "keyAuth", label: "Key 验证", level: "warning", detail: "429 限流（key 有效，已被限速）" };
  } else if (compat.level === "error") {
    auth = { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "API 兼容性检查未通过" };
  } else {
    auth = { id: "keyAuth", label: "Key 验证", level: "warning", detail: `HTTP ${status} — ${truncate(body, 120)}` };
  }

  return { compat, auth };
}

function checkKeyFormat(apiKey: string): Check {
  const k = apiKey.trim();
  if (!k) return { id: "keyFormat", label: "Key 格式", level: "error", detail: "API key 缺失" };
  if (/^Bearer\s+/i.test(k))
    return {
      id: "keyFormat",
      label: "Key 格式",
      level: "warning",
      detail: '已包含 "Bearer " 前缀（建议去掉）',
      hint: 'apiKey 只填裸 token，"Bearer " 前缀由系统自动添加。',
    };
  if (/^sk-ant-/i.test(k)) return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "官方格式 (sk-ant-…)" };
  if (/^sk-proj-/i.test(k))
    return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "OpenAI 项目密钥 (sk-proj-…)" };
  if (/^sk-[A-Za-z0-9]{20,}$/.test(k))
    return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "OpenAI 或兼容格式 (sk-…)" };
  return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "第三方格式" };
}

export async function testProviderOnboarding(p: ProviderInput): Promise<TestResult> {
  if (process.env.SATI_E2E_MOCK_PROVIDER === "1") {
    const { url } = resolveEndpoint(p);
    return {
      endpoint: url,
      overall: "ok",
      checks: [
        {
          id: "e2eMock",
          label: "E2E mock",
          level: "ok",
          detail: "SATI_E2E_MOCK_PROVIDER=1",
        },
      ],
    };
  }

  const { url } = resolveEndpoint(p);
  const network = await checkNetwork(p);

  let compat: Check;
  let auth: Check;
  if (network.level === "error") {
    compat = { id: "apiCompat", label: "API 兼容", level: "skipped", detail: "网络不通，跳过" };
    auth = { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "网络不通，跳过" };
  } else {
    ({ compat, auth } = await checkKeyAuth(p));
  }

  const keyFormat = checkKeyFormat(p.apiKey);
  const checks = [network, compat, auth, keyFormat];

  let overall: CheckLevel = "ok";
  for (const c of checks) {
    if (c.level === "error") {
      overall = "error";
      break;
    }
    if (c.level === "warning") overall = "warning";
  }

  return { endpoint: url, overall, checks };
}
