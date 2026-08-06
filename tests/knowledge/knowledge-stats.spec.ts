import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KnowledgeRuntimeStats } from "../../src/knowledge/shared/knowledge-stats.js";
import { CircuitBreaker } from "../../src/knowledge/shared/circuit-breaker.js";

describe("KnowledgeRuntimeStats", () => {
  it("初始快照全部为零值、无熔断器、默认状态", () => {
    const stats = new KnowledgeRuntimeStats();
    const snap = stats.snapshot();
    assert.equal(snap.cacheHits, 0);
    assert.equal(snap.cacheMisses, 0);
    assert.equal(snap.semanticCalls, 0);
    assert.equal(snap.semanticFailures, 0);
    assert.equal(snap.rerankCalls, 0);
    assert.equal(snap.rerankFailures, 0);
    assert.deepEqual(snap.breakers, []);
    assert.equal(snap.kgFtsMode, "unknown");
    assert.equal(snap.wikiSemanticIndex, "disabled");
  });

  it("计数器随打点累加", () => {
    const stats = new KnowledgeRuntimeStats();
    stats.recordCacheHit();
    stats.recordCacheHit();
    stats.recordCacheMiss();
    stats.recordSemanticCall();
    stats.recordSemanticFailure();
    stats.recordRerankCall();
    stats.recordRerankCall();
    stats.recordRerankFailure();
    const snap = stats.snapshot();
    assert.equal(snap.cacheHits, 2);
    assert.equal(snap.cacheMisses, 1);
    assert.equal(snap.semanticCalls, 1);
    assert.equal(snap.semanticFailures, 1);
    assert.equal(snap.rerankCalls, 2);
    assert.equal(snap.rerankFailures, 1);
  });

  it("注册熔断器后快照透传其状态（同名覆盖）", () => {
    const stats = new KnowledgeRuntimeStats();
    const breaker = new CircuitBreaker({});
    stats.registerBreaker("patent:semantic", breaker);
    let snap = stats.snapshot();
    assert.equal(snap.breakers.length, 1);
    assert.equal(snap.breakers[0]?.name, "patent:semantic");
    assert.equal(snap.breakers[0]?.state, "closed");

    // 同名后注册覆盖，不产生重复项
    const breaker2 = new CircuitBreaker({});
    stats.registerBreaker("patent:semantic", breaker2);
    snap = stats.snapshot();
    assert.equal(snap.breakers.length, 1);
  });

  it("setKgFtsMode / setWikiSemanticIndexState 写入后快照可见", () => {
    const stats = new KnowledgeRuntimeStats();
    stats.setKgFtsMode("trigram");
    stats.setWikiSemanticIndexState("ready");
    const snap = stats.snapshot();
    assert.equal(snap.kgFtsMode, "trigram");
    assert.equal(snap.wikiSemanticIndex, "ready");
  });

  it("snapshot 每次返回新对象（消费方可安全序列化）", () => {
    const stats = new KnowledgeRuntimeStats();
    const a = stats.snapshot();
    const b = stats.snapshot();
    assert.notEqual(a, b);
    assert.notEqual(a.breakers, b.breakers);
  });
});
