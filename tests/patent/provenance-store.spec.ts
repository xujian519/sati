import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { KnowledgeDbVersionError } from "../../src/knowledge/shared/db-version.js";
import { ProvenanceStore } from "../../src/patent/provenance/provenance-store.js";
import type { ProvenanceActivity, ProvenanceEntity } from "../../src/patent/provenance/types.js";

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "provenance-store-"));
  return { dir, path: join(dir, "provenance.db") };
}

function sampleActivity(id: string, overrides: Partial<ProvenanceActivity> = {}): ProvenanceActivity {
  return {
    id,
    source: "approval_gate",
    name: "approve",
    caseId: "case-1",
    runId: "patent_inventiveness_v1-1724100000000-1",
    startedAt: 1724100000000,
    agentId: "human",
    inputIds: ["entity-1"],
    ...overrides,
  };
}

function sampleEntity(id: string, overrides: Partial<ProvenanceEntity> = {}): ProvenanceEntity {
  return {
    id,
    kind: "conclusion",
    value: "具备创造性",
    caseId: "case-1",
    generatedByActivityId: "act-1",
    derivedFromIds: ["entity-closest", "entity-diff"],
    ...overrides,
  };
}

test("建库 + 写入/读取往返（含 JSON 数组列与可选字段）", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new ProvenanceStore(path);
    store.upsertAgent({ id: "human", kind: "human", name: "审批人" });
    store.upsertActivity(sampleActivity("act-1", { stepIndex: 3, durationMs: 1200 }));
    store.upsertEntity(sampleEntity("entity-1", { degraded: true }));

    const activities = store.listActivities();
    assert.equal(activities.length, 1);
    assert.deepEqual(activities[0], {
      id: "act-1",
      source: "approval_gate",
      name: "approve",
      caseId: "case-1",
      runId: "patent_inventiveness_v1-1724100000000-1",
      stepIndex: 3,
      startedAt: 1724100000000,
      durationMs: 1200,
      agentId: "human",
      inputIds: ["entity-1"],
    });

    const entities = store.listEntities();
    assert.equal(entities.length, 1);
    assert.deepEqual(entities[0], {
      id: "entity-1",
      kind: "conclusion",
      value: "具备创造性",
      caseId: "case-1",
      generatedByActivityId: "act-1",
      derivedFromIds: ["entity-closest", "entity-diff"],
      degraded: true,
    });

    const agents = store.listAgents();
    assert.equal(agents.length, 1);
    assert.deepEqual(agents[0], { id: "human", kind: "human", name: "审批人" });

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等：同 id 二次 upsert → 仍一条（resume 重放安全）", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new ProvenanceStore(path);
    store.upsertActivity(sampleActivity("act-1"));
    store.upsertActivity(sampleActivity("act-1", { durationMs: 999 }));
    assert.equal(store.listActivities().length, 1);
    assert.equal(store.listActivities()[0]!.durationMs, undefined); // 首次写入保留
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caseId 三态过滤：undefined 全部 / null 无归属 / string 精确", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new ProvenanceStore(path);
    store.upsertActivity(sampleActivity("act-1", { caseId: "case-1" }));
    store.upsertActivity(sampleActivity("act-2", { caseId: "case-2" }));
    store.upsertActivity(sampleActivity("act-3", { caseId: null }));

    assert.equal(store.listActivities().length, 3);
    assert.deepEqual(
      store.listActivities("case-1").map(a => a.id),
      ["act-1"],
    );
    assert.deepEqual(
      store.listActivities(null).map(a => a.id),
      ["act-3"],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("case_id NULLABLE：全局库记录（无 case 归属）正常写入与读取", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new ProvenanceStore(path);
    store.upsertEntity(sampleEntity("entity-global", { caseId: null }));
    const entities = store.listEntities(null);
    assert.equal(entities.length, 1);
    assert.equal(entities[0]!.caseId, null);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("application_id 魔数校验：打开他库抛 KnowledgeDbVersionError", () => {
  const { dir, path } = tempDbPath();
  try {
    // 预建一个魔数错误的库（模拟误开他库）
    const db = new DatabaseSync(path);
    db.exec("PRAGMA application_id = 0x12345678");
    db.close();
    assert.throws(() => new ProvenanceStore(path), KnowledgeDbVersionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kind:source 版本高于当前 → fail-loud 拒开（不静默重建）", () => {
  const { dir, path } = tempDbPath();
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 2"); // 未来版本
    db.close();
    assert.throws(() => new ProvenanceStore(path), KnowledgeDbVersionError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kind:source 版本为 0（存量库）→ 宽容补戳打开", () => {
  const { dir, path } = tempDbPath();
  try {
    const db = new DatabaseSync(path);
    db.close();
    const store = new ProvenanceStore(path); // 空文件 → version 0 → 宽容补戳
    store.upsertActivity(sampleActivity("act-1"));
    assert.equal(store.listActivities().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("close() 后释放句柄：库文件可删除；再操作抛错", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new ProvenanceStore(path);
    store.upsertActivity(sampleActivity("act-1"));
    store.close();
    // close 后可删库（Windows EBUSY 语义）
    rmSync(path, { force: true });
    // close 后再操作抛错
    assert.throws(() => store.upsertActivity(sampleActivity("act-2")), /已关闭/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("库文件不存在时自动建父目录", () => {
  const dir = mkdtempSync(join(tmpdir(), "provenance-nested-"));
  try {
    const nested = join(dir, "a", "b", "provenance.db");
    const store = new ProvenanceStore(nested);
    store.upsertActivity(sampleActivity("act-1"));
    assert.equal(store.listActivities().length, 1);
    store.close();
    assert.ok(existsSync(nested)); // 库文件已落盘（含自动建的父目录）
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
