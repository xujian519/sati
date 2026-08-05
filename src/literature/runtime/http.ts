/**
 * 学术文献连接器共享 HTTP 层（在核心 networkFetch 之上包装）。
 *
 * 核心网络层已提供超时/重试/退避/Retry-After/结构化错误。文献场景在此之上
 * 补充三件事（设计引入自 OpenScience connectors/http.ts）：
 *   - per-host 礼貌限速：arXiv 要求 ≤1 req/3s、keyless Semantic Scholar ~1s。
 *     按 URL host 排队，多库并发 fan-out 不会被过度串行化。
 *   - 进程内 GET 短 TTL 缓存 + `looksValid` 谓词：空 body 或非预期格式
 *     （HTML 错误页）不缓存，防污染。
 *   - Accept 内容协商：默认 "* / *"（arXiv Atom、PubMed EFetch 等 XML 源），
 *     JSON 连接器经 `getJSON` 显式声明。
 *
 * 本层服务的全部是免费、公开、无 API key 的数据源；需要鉴权的源应在连接器
 * 内显式叠加，不写在这里。
 */
import { networkFetch, type NetworkRetryOptions } from "../../network/fetch.js";

export interface LiteratureRateLimit {
  /** 同一 host 两次请求开始之间的最小间隔（ms）。 */
  minIntervalMs?: number;
  /** 同一 host 最大并发在途请求数。 */
  maxConcurrent?: number;
}

export interface LiteratureFetchOptions {
  /** 请求超时（默认 30s）。 */
  timeoutMs?: number;
  /** 外部取消信号。 */
  signal?: AbortSignal;
  /** GET 缓存 TTL（ms）；0 禁用（默认 5 分钟）。 */
  cacheTtlMs?: number;
  /**
   * 缓存门：返回 `false` 阻止 2xx body 进缓存（如源返回了 HTML/空内容而非
   * 预期负载）。空 body 一律不缓存。
   */
  looksValid?: (body: string) => boolean;
  /** 内容协商 Accept 头（默认 "* / *"）。 */
  accept?: string;
  /** 额外请求头（如 Semantic Scholar 的 x-api-key）。 */
  headers?: Record<string, string>;
  /** 可选 per-host 礼貌限速。 */
  rateLimit?: LiteratureRateLimit;
  /** 重试配置（默认 3 次指数退避）。 */
  retry?: NetworkRetryOptions;
  /** 覆盖 fetch（测试注入）。 */
  fetchImpl?: typeof fetch;
}

export interface LiteratureResponse {
  ok: boolean;
  status: number;
  body: string;
}

/** 非 2xx 终态响应（重试耗尽后）；`status` + 截断 body 供调用方诊断。 */
export class LiteratureHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "LiteratureHttpError";
  }
}

const USER_AGENT = "sati-literature/0.1 (+https://github.com/xujian519/sati)";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_RETRY: NetworkRetryOptions = { maxRetries: 3, baseDelayMs: 1000, maxDelayMs: 15_000 };

// ── per-host 礼貌限速 ───────────────────────────────────────────────────────
// pacing 串行化并间隔同一 host 的请求开始；并发上限约束在途请求数。
// 按 host 键控，互不相关的源不会被过度串行化。

const hostPace = new Map<string, Promise<void>>();
const hostActive = new Map<string, number>();
const hostWaiters = new Map<string, Array<() => void>>();

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

/**
 * 解析到该 host 可以开始下一个请求。空闲窗口中的首个请求立即返回；其后的
 * 每个请求保持到上一个请求开始 `minIntervalMs` 之后。
 */
function pace(host: string, minIntervalMs: number): Promise<void> {
  const ready = hostPace.get(host) ?? Promise.resolve();
  hostPace.set(
    host,
    ready.then(() => sleep(minIntervalMs)),
  );
  return ready;
}

/** 占用一个在途槽位；达 `maxConcurrent` 则等待。 */
function acquire(host: string, maxConcurrent: number): Promise<void> {
  const active = hostActive.get(host) ?? 0;
  if (active < maxConcurrent) {
    hostActive.set(host, active + 1);
    return Promise.resolve();
  }
  return new Promise<void>(resolve => {
    const queue = hostWaiters.get(host) ?? [];
    queue.push(resolve);
    hostWaiters.set(host, queue);
  });
}

/** 释放一个在途槽位，直接转交给下一个等待者（如有）。 */
function release(host: string): void {
  const next = hostWaiters.get(host)?.shift();
  if (next) return next();
  const active = hostActive.get(host) ?? 1;
  hostActive.set(host, Math.max(0, active - 1));
}

/** 应用可选 per-host 限速；返回完成后调用的 `release`。 */
async function throttle(url: string, limit?: LiteratureRateLimit): Promise<() => void> {
  const host = hostOf(url);
  if (!host || !limit) return () => {};
  if (limit.minIntervalMs && limit.minIntervalMs > 0) await pace(host, limit.minIntervalMs);
  if (limit.maxConcurrent && limit.maxConcurrent > 0) {
    await acquire(host, limit.maxConcurrent);
    return () => release(host);
  }
  return () => {};
}

// ── GET 缓存（防污染） ──────────────────────────────────────────────────────

/** 缓存条目上限：超限按 LRU 淘汰最久未访问项，防止长时间运行（分页检索等）无限增长。 */
const MAX_CACHE_ENTRIES = 500;
const cache = new Map<string, { expires: number; body: string }>();

/** 写入缓存并维护 LRU 顺序（Map 插入序 = 最近访问序）。 */
function cacheSet(key: string, value: { expires: number; body: string }): void {
  cache.delete(key);
  cache.set(key, value);
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) cache.delete(oldest.value);
  }
}

/**
 * 执行一次带超时/重试/限速/缓存的 HTTP 请求。
 *
 * 网络层错误（DNS/超时/连接）以 `NetworkFetchError` 上抛；HTTP 非 2xx 在
 * 重试耗尽后原样返回（`ok: false`），由 `getText`/`getJSON` 转为
 * `LiteratureHttpError`。空 body 或未通过 `looksValid` 的 2xx body 不缓存。
 *
 * 已知边界：pace 门控的是本次请求的"开始"；`networkFetch` 内部的指数退避
 * 重试不再过闸（重试间隔由退避/Retry-After 决定，可能短于 minIntervalMs）。
 * 因此 pace 保证的是外部调用方的请求节奏，不覆盖单次请求内部的重试风暴——
 * 源返回 429 时 networkFetch 尊重 Retry-After，无该头时按退避间隔重试。
 */
export async function literatureFetch(url: string, opts: LiteratureFetchOptions = {}): Promise<LiteratureResponse> {
  const ttl = opts.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  // 缓存键并入 Accept（getText 与 getJSON 对同一 URL 的结果不可互换），
  // 避免内容协商结果互相污染。
  const cacheKey = ttl > 0 ? `GET ${opts.accept ?? "*/*"} ${url}` : undefined;
  if (cacheKey) {
    const hit = cache.get(cacheKey);
    if (hit && hit.expires > Date.now()) {
      // 刷新 LRU 顺序（重新插入到尾部）
      cache.delete(cacheKey);
      cache.set(cacheKey, hit);
      return { ok: true, status: 200, body: hit.body };
    }
    if (hit) cache.delete(cacheKey);
  }

  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: opts.accept ?? "*/*",
    ...(opts.headers ?? {}),
  };

  const done = await throttle(url, opts.rateLimit);
  try {
    const res = await networkFetch(
      url,
      { headers, signal: opts.signal },
      {
        timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        signal: opts.signal,
        fetchImpl: opts.fetchImpl,
        retry: opts.retry ?? DEFAULT_RETRY,
      },
    );
    const body = await res.text();
    // 只缓存健康的 2xx 响应；空 body / looksValid 拒绝的 body 一律不缓存。
    const valid = res.ok && body.trim().length > 0 && (opts.looksValid?.(body) ?? true);
    if (cacheKey && valid) cacheSet(cacheKey, { expires: Date.now() + ttl, body });
    return { ok: res.ok, status: res.status, body };
  } finally {
    done();
  }
}

/** GET + 文本。非 2xx 抛 `LiteratureHttpError`。 */
export async function getText(url: string, opts?: LiteratureFetchOptions): Promise<string> {
  const res = await literatureFetch(url, opts);
  if (!res.ok) {
    throw new LiteratureHttpError(res.status, `HTTP ${res.status} for ${url}: ${res.body.slice(0, 500)}`);
  }
  return res.body;
}

/** GET + JSON（默认 Accept: application/json）。 */
export async function getJSON<T = unknown>(url: string, opts?: LiteratureFetchOptions): Promise<T> {
  const res = await literatureFetch(url, { ...opts, accept: opts?.accept ?? "application/json" });
  if (!res.ok) {
    throw new LiteratureHttpError(res.status, `HTTP ${res.status} for ${url}: ${res.body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(res.body) as T;
  } catch (error) {
    throw new Error(`Non-JSON response from ${url}: ${res.body.slice(0, 500)}`, { cause: error });
  }
}

/** 清空内存缓存（测试/调试辅助）。 */
export function clearCache(): void {
  cache.clear();
}

/** 重置 per-host 限速 pacing + 并发状态（测试/调试辅助）。 */
export function resetRateLimits(): void {
  hostPace.clear();
  hostActive.clear();
  hostWaiters.clear();
}
