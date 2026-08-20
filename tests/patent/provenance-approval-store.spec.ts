import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApprovalRecord, type ApprovalRecord } from "../../src/patent/approval.js";
import { APPROVAL_AUDIT_DB, SqliteApprovalStore } from "../../src/patent/provenance/approval-store.js";
import { provenanceAuditDir } from "../../src/patent/paths.js";
import type { RuleViolation } from "../../src/rule/index.js";

function tempDbPath(): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "provenance-approval-"));
  return { dir, path: join(dir, "approval-audit.db") };
}

function sampleRecord(
  overrides: Partial<ApprovalRecord> = {},
  now = new Date("2026-08-20T10:00:00.000Z"),
): ApprovalRecord {
  return createApprovalRecord({
    pendingIndex: 1,
    sessionId: "session-1",
    turnId: "turn-1",
    triggerKeyword: "创造性结论",
    originalOutputPreview: "本发明具备创造性……",
    verdict: "adopted",
    now: () => now,
    ...overrides,
  });
}

const sampleViolation: RuleViolation = {
  ruleId: "INVENTIVENESS-CONCLUSION-1",
  ruleName: "创造性结论规范",
  severity: "major",
  action: "block",
  message: "结论缺少三步法依据",
  evidence: ["最接近现有技术未给出"],
};

test("saveRecord 落盘 + listRecords 还原（含扩展字段 caseId/runId/ruleViolations）", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SqliteApprovalStore(path);
    const record = sampleRecord({ caseId: "case-1", runId: "run-1", ruleViolations: [sampleViolation] });
    store.saveRecord(record);

    assert.ok(existsSync(path)); // 全局库已落盘
    const records = store.listRecords();
    assert.equal(records.length, 1);
    assert.deepEqual(records[0], record);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("幂等：同一记录二次 save → 仍一条", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SqliteApprovalStore(path);
    const record = sampleRecord();
    store.saveRecord(record);
    store.saveRecord(record);
    assert.equal(store.listRecords().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caseId 缺失（output_gate 无 case 归属）→ case_id 置 NULL 不伪造", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SqliteApprovalStore(path);
    store.saveRecord(sampleRecord()); // 无 caseId
    const records = store.listRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.caseId, undefined);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fail-open：写入失败不外泄（close 后 saveRecord 静默告警不抛）", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SqliteApprovalStore(path);
    store.close();
    // close 后内部 ProvenanceStore 抛"已关闭"，saveRecord 必须吞掉（审批流程不受影响）
    assert.doesNotThrow(() => store.saveRecord(sampleRecord()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("多条记录按决定时间升序", () => {
  const { dir, path } = tempDbPath();
  try {
    const store = new SqliteApprovalStore(path);
    store.saveRecord(sampleRecord({ pendingIndex: 1 }, new Date("2026-08-20T10:00:00.000Z")));
    store.saveRecord(sampleRecord({ pendingIndex: 2 }, new Date("2026-08-20T09:00:00.000Z")));
    store.saveRecord(sampleRecord({ pendingIndex: 3 }, new Date("2026-08-20T11:00:00.000Z")));
    assert.deepEqual(
      store.listRecords().map(r => r.pendingIndex),
      [2, 1, 3],
    );
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺省 dbPath 解析到全局审计库路径（SATI_PROVENANCE_DIR 可覆盖）", () => {
  const dir = mkdtempSync(join(tmpdir(), "provenance-auditdir-"));
  try {
    const original = process.env.SATI_PROVENANCE_DIR;
    process.env.SATI_PROVENANCE_DIR = dir;
    try {
      assert.equal(provenanceAuditDir(), dir);
      const store = new SqliteApprovalStore();
      store.saveRecord(sampleRecord());
      assert.ok(existsSync(join(dir, APPROVAL_AUDIT_DB)));
      store.close();
    } finally {
      if (original === undefined) delete process.env.SATI_PROVENANCE_DIR;
      else process.env.SATI_PROVENANCE_DIR = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
