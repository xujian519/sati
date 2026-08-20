import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { caseProvenanceDir } from "../../src/patent/paths.js";
import { ProvenanceStore } from "../../src/patent/provenance/provenance-store.js";
import { resolveProvenanceRunId } from "../../src/patent/provenance/run-id.js";
import { openProvenanceCollector } from "../../src/tool/builtin/patentWorkflowRunTool.js";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.SATI_PROVENANCE;
  if (value === undefined) delete process.env.SATI_PROVENANCE;
  else process.env.SATI_PROVENANCE = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.SATI_PROVENANCE;
    else process.env.SATI_PROVENANCE = original;
  }
}

test("openProvenanceCollector：开关关 → null（零开销）", () => {
  withEnv(undefined, () => {
    const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
    try {
      assert.equal(
        openProvenanceCollector({ caseId: "case-1", cwd, runKey: "patent_drafting_v1", resume: false }),
        null,
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("openProvenanceCollector：开启但无 caseId → null", () => {
  withEnv("1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
    try {
      assert.equal(openProvenanceCollector({ cwd, runKey: "patent_drafting_v1", resume: false }), null);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("openProvenanceCollector：开启 + caseId → collector（库落盘于 caseProvenanceDir）", () => {
  withEnv("1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
    try {
      const collector = openProvenanceCollector({
        caseId: "case-1",
        cwd,
        runKey: "patent_drafting_v1",
        resume: false,
      });
      assert.ok(collector !== null);
      assert.equal(collector.caseId, "case-1");
      assert.ok(collector.runId.startsWith("patent_drafting_v1-"));
      collector.recordApprovalGate({ stageId: "review_gate", kind: "pending", message: "待人工复核" });
      collector.close();
      // 重新打开验证落盘位置与内容
      const store = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
      const activities = store.listActivities("case-1");
      assert.equal(activities.length, 1);
      assert.equal(activities[0]!.source, "approval_gate");
      assert.equal(activities[0]!.name, "pending");
      assert.equal(activities[0]!.runId, collector.runId);
      store.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

test("resolveProvenanceRunId：新运行生成，resume 复用同一 runId", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
  try {
    const first = resolveProvenanceRunId({ caseId: "case-1", cwd, runKey: "patent_inventiveness", resume: false });
    const resumed = resolveProvenanceRunId({ caseId: "case-1", cwd, runKey: "patent_inventiveness", resume: true });
    assert.equal(resumed, first); // 续跑复用
    const rerun = resolveProvenanceRunId({ caseId: "case-1", cwd, runKey: "patent_inventiveness", resume: false });
    assert.notEqual(rerun, first); // 新运行新 runId（不覆盖审计历史）
    assert.ok(existsSync(join(caseProvenanceDir("case-1", cwd), "patent_inventiveness.run.json")));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resolveProvenanceRunId：损坏的 run.json → 新建 runId", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
  try {
    const runFile = join(caseProvenanceDir("case-1", cwd), "patent_drafting_v1.run.json");
    mkdirSync(join(caseProvenanceDir("case-1", cwd)), { recursive: true });
    writeFileSync(runFile, "{broken", "utf8");
    const runId = resolveProvenanceRunId({ caseId: "case-1", cwd, runKey: "patent_drafting_v1", resume: true });
    assert.ok(runId.startsWith("patent_drafting_v1-"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("recordApprovalGate：pending/granted 幂等（同 stage 同 kind 二次记录仍一条）", () => {
  withEnv("1", () => {
    const cwd = mkdtempSync(join(tmpdir(), "provenance-hooks-"));
    try {
      const collector = openProvenanceCollector({
        caseId: "case-1",
        cwd,
        runKey: "patent_drafting_v1",
        resume: false,
      })!;
      assert.ok(collector !== null);
      collector.recordApprovalGate({ stageId: "review_gate", kind: "granted" });
      collector.recordApprovalGate({ stageId: "review_gate", kind: "granted" });
      collector.close();
      const reopened = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
      const granted = reopened.listActivities("case-1").filter(a => a.name === "granted");
      assert.equal(granted.length, 1);
      reopened.close();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
