import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TtlCache } from "../../src/knowledge/shared/ttl-cache.js";

describe("TtlCache", () => {
  it("TTL 内命中，过期后 miss 并惰性清除", () => {
    let t = 0;
    const cache = new TtlCache<string, string>({ ttlMs: 100, now: () => t });
    cache.set("k", "v");
    assert.equal(cache.get("k"), "v");
    assert.equal(cache.size, 1);
    t = 100; // 到期（>= expiresAt）
    assert.equal(cache.get("k"), undefined);
    assert.equal(cache.size, 0, "过期条目应被清除");
  });

  it("未过期条目不受时间影响", () => {
    let t = 0;
    const cache = new TtlCache<string, string>({ ttlMs: 100, now: () => t });
    cache.set("k", "v");
    t = 99;
    assert.equal(cache.get("k"), "v");
  });

  it("maxSize 超限淘汰最旧条目", () => {
    const cache = new TtlCache<string, string>({ ttlMs: 1000, maxSize: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3"); // 淘汰 "a"
    assert.equal(cache.get("a"), undefined);
    assert.equal(cache.get("b"), "2");
    assert.equal(cache.get("c"), "3");
    assert.equal(cache.size, 2);
  });

  it("clear 清空全部", () => {
    const cache = new TtlCache<string, string>({ ttlMs: 1000 });
    cache.set("a", "1");
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("a"), undefined);
  });

  it("不同 key 互不影响", () => {
    const cache = new TtlCache<string, string>({ ttlMs: 1000 });
    cache.set("a", "1");
    cache.set("b", "2");
    assert.equal(cache.get("a"), "1");
    assert.equal(cache.get("b"), "2");
  });
});
