/**
 * 短时 TTL 缓存——同 query 的重复知识检索直接命中，减少每 turn 全量重查。
 *
 * 惰性过期（get 时检查），可选 maxSize 防泄漏（超出淘汰最旧条目）。
 * 仅进程内短时优化，重启即失效，符合知识库只读设计（captureTurn 空操作）。
 */

export type TtlCacheOptions = {
  /** 条目存活时长 ms。 */
  ttlMs: number;
  /** 最大条目数（默认 128，超出淘汰最旧）。 */
  maxSize?: number;
  /** 时钟注入（测试用）。 */
  now?: () => number;
};

export class TtlCache<K, V> {
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private readonly now: () => number;
  private readonly entries = new Map<K, { value: V; expiresAt: number }>();

  constructor(options: TtlCacheOptions) {
    this.ttlMs = options.ttlMs;
    this.maxSize = options.maxSize ?? 128;
    this.now = options.now ?? Date.now;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: K, value: V): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
    if (this.entries.size > this.maxSize) {
      // Map 迭代序 = 插入序，淘汰最旧条目。
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
  }

  /** 删除指定键（无论是否过期）。 */
  delete(key: K): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
