/**
 * src/patent/data/nuo/patentCache — 专利检索/点查结果缓存（LRU + TTL + 并发合并）。
 *
 * 背景：`nuo-patent` 是 vendored 预构建产物（vendor/nuo-patent/dist，无源码），
 * 其 `searchPatents`/`scrapePatent` 每次调用都经 `fetchHtml` 走一轮网络请求，
 * 且安装了 ego-browser 时每次都会 spawn 一个新子进程（30s 超时 + 15s 缓冲）。
 * 桌面端工作日志显示同一轮会话内同一检索式会被反复执行（大量 cache=MISS、
 * results=0 重试），白白烧网络与进程。
 *
 * 本模块在 Sati 侧包装 nuo-patent 的纯函数，提供：
 *   - LRU 结果缓存（懒过期，读时剔除）；
 *   - in-flight 合并：同一 key 的并发调用共享同一次底层请求（agent 多工具并行
 *     或重试场景避免重复打源）；
 *   - 失败不缓存：仅缓存"成功"结果，网络错误/超时/0 命中不污染缓存。
 *
 * 与 `src/tool/builtin/web/urlContentCache.ts` 的差异：后者按 URL 缓存字节流，
 * 本模块按业务 key 缓存结构化结果，并额外做并发去重。
 */

import type { PatentSearchResult, ScrapeResult } from "nuo-patent";

export type PatentCacheOptions<T> = {
  /** 条目 TTL（毫秒），默认 10 分钟。 */
  ttlMs?: number;
  /** LRU 最大条目数，默认 100。 */
  maxEntries?: number;
  /** 按 key/value 分类的 TTL 覆盖（毫秒），优先级高于 ttlMs；返回 undefined 用默认。 */
  ttlFor?: (key: string, value: T) => number | undefined;
};

type CacheNode<T> = { value: T; expiresAt: number };

/**
 * 通用异步结果缓存：LRU + TTL + in-flight 合并。
 * 仅缓存 loader 成功 resolve 的值；reject/抛错不写缓存。
 */
export class AsyncResultCache<T> {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly ttlFor?: (key: string, value: T) => number | undefined;
  private readonly map = new Map<string, CacheNode<T>>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(options: PatentCacheOptions<T> = {}) {
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 100;
    this.ttlFor = options.ttlFor;
  }

  /**
   * 命中缓存直接返回；未命中时并发去重后调用 loader。
   * 并发调用同一 key：共享同一 pending promise，只触发一次底层请求。
   * `shouldCache` 可选：默认全部缓存；返回 false 时结果仅透传、不写缓存
   * （用于"网络错误/空结果不缓存"语义）。
   */
  async getOrLoad(key: string, loader: () => Promise<T>, shouldCache?: (value: T) => boolean): Promise<T> {
    const pending = this.inflight.get(key);
    if (pending) return pending;

    const node = this.map.get(key);
    if (node) {
      if (Date.now() < node.expiresAt) {
        // LRU 触摸：删除重插，移到队尾（最新）。
        this.map.delete(key);
        this.map.set(key, node);
        return node.value;
      }
      this.map.delete(key);
    }

    const promise = loader().then(
      value => {
        if (shouldCache === undefined || shouldCache(value)) {
          this.set(key, value);
        }
        return value;
      },
      error => {
        // 失败不缓存（也不保留 in-flight 之外的痕迹）。
        throw error;
      },
    );
    this.inflight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inflight.delete(key);
    }
  }

  private set(key: string, value: T): void {
    const existing = this.map.get(key);
    if (existing) {
      this.map.delete(key);
    }
    while (this.map.size >= this.maxEntries) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) break;
      this.map.delete(oldestKey);
    }
    const ttlMs = this.ttlFor?.(key, value) ?? this.ttlMs;
    this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** 清空缓存（含在途合并表）。测试/显式失效用。 */
  clear(): void {
    this.map.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

/** 检索结果是否为"可缓存"的成功态：无失败类 warning（与 patentSearch 工具判定一致）。 */
export function isSearchResultCacheable(result: PatentSearchResult): boolean {
  const failure = result.warnings.find(w => /^(查询条件为空|检索超时|检索失败)/.test(w));
  return !failure;
}

/** 点查结果是否为"可缓存"的成功态。 */
export function isScrapeResultCacheable(result: ScrapeResult): boolean {
  return result.success === true;
}

/** 构造检索缓存 key（query + limit；timeout/signal 不参与——结果与它们无关）。 */
export function searchCacheKey(query: string, limit: number): string {
  return `search\u0000${query}\u0000${limit}`;
}

/** 构造点查缓存 key（patent + 内容开关；timeout/signal 不参与）。 */
export function scrapeCacheKey(patent: string, opts: { returnAbstract: boolean; returnLegal: boolean }): string {
  return `scrape\u0000${patent}\u0000${opts.returnAbstract ? 1 : 0}${opts.returnLegal ? 1 : 0}`;
}

/** P3-01：法律状态类检索式关键词（命中 → TTL 5min，法律状态变化较快）。 */
const LEGAL_STATUS_QUERY_RE = /(legal\s+status|法律状态|无效|失效|终止|驳回|revoked?|expired|lapsed)/i;

/** P3-01：零命中缓存 1 分钟（防短时间重复打源，又允许较快重试）。 */
const ZERO_HIT_TTL_MS = 60 * 1000;
/** P3-01：法律状态类检索缓存 5 分钟（法律状态比技术信息变化快）。 */
const LEGAL_STATUS_TTL_MS = 5 * 60 * 1000;
/** P3-01：其余检索缓存 2 小时（技术检索结果相对稳定）。 */
const DEFAULT_SEARCH_TTL_MS = 2 * 60 * 60 * 1000;

/**
 * P3-01：检索结果 TTL 分层——零命中 1min / 法律状态关键词 5min / 其余 2h。
 * key 为 `searchCacheKey` 格式（`search\x00<query>\x00<limit>`）。
 */
export function searchResultTtlMs(key: string, value: PatentSearchResult): number {
  if (value.hits.length === 0) return ZERO_HIT_TTL_MS;
  const query = key.split("\u0000")[1] ?? "";
  if (LEGAL_STATUS_QUERY_RE.test(query)) return LEGAL_STATUS_TTL_MS;
  return DEFAULT_SEARCH_TTL_MS;
}

// 进程级共享缓存：按 impl 函数身份分桶（WeakMap，key 为 impl 函数对象）。
// 背景：createBuiltinRegistry / createNuoSearchProvider 随 runtime 重建会丢弃
// 旧缓存实例，导致同一检索式在新会话重新 spawn ego-browser（30s 超时 + 15s
// 缓冲）——M9 数据缓存无配置依赖，跨会话共享安全。
// #11 修复：不得用单一进程级缓存单例——不同 impl（数据源适配器/测试注入
// mock）对同一业务 key 可能返回不同结果，单例会跨 impl 互串（把 A 的结果喂
// 给 B）。按 impl 分桶后：同一 impl（模块级 nuo-patent 函数引用，跨重建身份
// 稳定）共享缓存，不同 impl 互不污染。
// 测试隔离：同 key 缓存可能跨用例互串，spec 在 beforeEach 调 resetPatentCacheSingletons()。
// 用 Map 而非 WeakMap：键为模块级函数引用（nuo-patent import / 调用方持有的
// impl），生命周期与进程同长，Map 持有不会泄漏；且 Map 可迭代，reset 能清空
// 全部分桶（WeakMap 不可迭代）。
const sharedSearchCaches = new Map<object, AsyncResultCache<PatentSearchResult>>();
const sharedScrapeCaches = new Map<object, AsyncResultCache<ScrapeResult>>();

/** 清空全部共享分桶缓存（测试隔离用；生产路径无调用）。 */
export function resetPatentCacheSingletons(): void {
  for (const cache of sharedSearchCaches.values()) cache.clear();
  for (const cache of sharedScrapeCaches.values()) cache.clear();
}

/**
 * 包装 nuo-patent `searchPatents`：LRU 缓存 + 并发合并 + TTL 分层。
 * 返回同签名函数，可作 `createPatentSearchTool({ search })` 或
 * `createNuoSearchProvider({ search })` 的默认实现。
 * 无自定义 options 时按 impl 身份共享进程级缓存（同一 impl 跨 registry 重建
 * 存活，不同 impl 互不污染）；传 options（测试/特殊 TTL）时新建独立缓存。
 */
export function cachedSearchPatents(
  impl: (query: string, options?: { limit?: number }) => Promise<PatentSearchResult>,
  options: PatentCacheOptions<PatentSearchResult> = {},
): (query: string, options?: { limit?: number }) => Promise<PatentSearchResult> {
  const hasCustomOptions = Object.keys(options).length > 0;
  let cache: AsyncResultCache<PatentSearchResult> | undefined;
  if (hasCustomOptions) {
    cache = createSearchCache(options);
  } else {
    cache = sharedSearchCaches.get(impl);
    if (!cache) {
      cache = createSearchCache();
      sharedSearchCaches.set(impl, cache);
    }
  }
  return async (query, opts) => {
    const limit = opts?.limit ?? 10;
    return cache.getOrLoad(searchCacheKey(query, limit), () => impl(query, { limit }), isSearchResultCacheable);
  };
}

/** 构造检索缓存（默认 TTL 分层：零命中 1min / 法律状态 5min / 其余 2h）。 */
function createSearchCache(options: PatentCacheOptions<PatentSearchResult> = {}): AsyncResultCache<PatentSearchResult> {
  return new AsyncResultCache<PatentSearchResult>({
    ...options,
    ttlMs: options.ttlMs ?? DEFAULT_SEARCH_TTL_MS,
    ttlFor: options.ttlFor ?? searchResultTtlMs,
  });
}

/**
 * 包装 nuo-patent `scrapePatent`：LRU 缓存 + 并发合并。
 * 仅缓存 success 的结果；NOT_FOUND/超时/解析失败不缓存（下次重试仍可触达源）。
 * 无自定义 options 时按 impl 身份共享进程级缓存（同上）；传 options 时新建
 * 独立缓存。
 */
export function cachedScrapePatent(
  impl: (patent: string, options?: { returnAbstract?: boolean; returnLegal?: boolean }) => Promise<ScrapeResult>,
  options: PatentCacheOptions<ScrapeResult> = {},
): (patent: string, options?: { returnAbstract?: boolean; returnLegal?: boolean }) => Promise<ScrapeResult> {
  const hasCustomOptions = Object.keys(options).length > 0;
  let cache: AsyncResultCache<ScrapeResult> | undefined;
  if (hasCustomOptions) {
    cache = new AsyncResultCache<ScrapeResult>(options);
  } else {
    cache = sharedScrapeCaches.get(impl);
    if (!cache) {
      cache = new AsyncResultCache<ScrapeResult>(options);
      sharedScrapeCaches.set(impl, cache);
    }
  }
  return async (patent, opts) => {
    const returnAbstract = opts?.returnAbstract ?? true;
    const returnLegal = opts?.returnLegal ?? true;
    return cache.getOrLoad(
      scrapeCacheKey(patent, { returnAbstract, returnLegal }),
      () => impl(patent, { returnAbstract, returnLegal }),
      isScrapeResultCacheable,
    );
  };
}
