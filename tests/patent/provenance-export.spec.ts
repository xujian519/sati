import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApprovalRecord } from "../../src/patent/approval.js";
import { caseProvenanceDir } from "../../src/patent/paths.js";
import { SqliteApprovalStore } from "../../src/patent/provenance/approval-store.js";
import { csvEscape, exportProvenance } from "../../src/patent/provenance/export.js";
import { ProvenanceStore } from "../../src/patent/provenance/provenance-store.js";
import { ProvenanceCollector } from "../../src/patent/provenance/collector.js";

function perCaseCollector(cwd: string): ProvenanceCollector {
  const store = new ProvenanceStore(join(caseProvenanceDir("case-1", cwd), "provenance.db"));
  return new ProvenanceCollector({ store, runId: "patent_drafting_v1-1-1", caseId: "case-1" });
}

test("csvEscape：逗号/引号/换行包裹，内部引号加倍", () => {
  assert.equal(csvEscape("plain"), "plain");
  assert.equal(csvEscape("a,b"), '"a,b"');
  assert.equal(csvEscape('a"b'), '"a""b"');
  assert.equal(csvEscape("a\nb"), '"a\nb"');
  assert.equal(csvEscape('技术特征, 引号" 换行\n'), '"技术特征, 引号"" 换行\n"');
});

test("exportProvenance csv：时间线列头与行内容（含审批结论列）", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-export-"));
  try {
    const collector = perCaseCollector(cwd);
    collector.recordApprovalGate({ stageId: "review_gate", kind: "pending", message: "待人工复核", at: 1724100000000 });
    collector.recordApprovalGate({ stageId: "review_gate", kind: "granted", at: 1724100100000 });
    collector.close();

    const csv = exportProvenance({ caseId: "case-1", format: "csv", cwd }).toString("utf8");
    const lines = csv.split("\n");
    assert.equal(lines[0], "时间,来源,活动,执行者,输入(used),产出,审批结论");
    assert.equal(lines.length, 3); // 头 + 2 行
    assert.match(lines[1]!, /^2024-08-19T.*,approval_gate,pending,human,,"/); // pending 行：产出含 JSON 摘要
    assert.ok(lines[1]!.endsWith("pending")); // 审批结论列 = kind
    assert.ok(lines[2]!.endsWith("granted"));
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exportProvenance csv：产出列含逗号时正确转义（RFC 4180）", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-export-"));
  try {
    const collector = perCaseCollector(cwd);
    collector.recordWorker({
      record: {
        workerName: "patent-technical-analyzer",
        inputValid: true,
        outputValid: true,
        degraded: false,
        startedAt: 1724100000000,
        durationMs: 500,
      },
      outputPath: 'data/cases/case-1/outputs/技术分析, 含引号"报告.md',
    });
    collector.close();

    const csv = exportProvenance({ caseId: "case-1", format: "csv", cwd }).toString("utf8");
    const line = csv.split("\n")[1]!;
    assert.ok(line.includes('"data/cases/case-1/outputs/技术分析, 含引号""报告.md"'));
    // 正确解析（处理 "" 转义）后列数仍为 7，且产出列还原原文
    const columns = parseCsvLine(line);
    assert.equal(columns.length, 7);
    assert.equal(columns[5], 'data/cases/case-1/outputs/技术分析, 含引号"报告.md');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

/** RFC 4180 CSV 行解析（引号内逗号不切分，"" 还原为 "）。 */
function parseCsvLine(line: string): string[] {
  const columns: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      columns.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  columns.push(current);
  return columns;
}

test("exportProvenance json：activities/entities/agents 完整导出", () => {
  const cwd = mkdtempSync(join(tmpdir(), "provenance-export-"));
  try {
    const collector = perCaseCollector(cwd);
    collector.recordApprovalGate({ stageId: "review_gate", kind: "pending" });
    collector.close();

    const raw = exportProvenance({ caseId: "case-1", format: "json", cwd }).toString("utf8");
    const data = JSON.parse(raw) as { activities: unknown[]; entities: unknown[]; agents: unknown[] };
    assert.equal(data.activities.length, 1);
    assert.equal(data.entities.length, 1);
    assert.equal(data.agents.length, 1);
    assert.equal((data.activities[0] as { source: string }).source, "approval_gate");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("exportProvenance caseId=null：导出全局审批审计库", () => {
  const dir = mkdtempSync(join(tmpdir(), "provenance-export-"));
  try {
    const original = process.env.SATI_PROVENANCE_DIR;
    process.env.SATI_PROVENANCE_DIR = dir;
    try {
      const store = new SqliteApprovalStore();
      store.saveRecord(
        createApprovalRecord({
          pendingIndex: 1,
          sessionId: "session-1",
          triggerKeyword: "创造性结论",
          originalOutputPreview: "本发明具备创造性",
          verdict: "rejected",
          feedback: "缺少三步法论证",
          now: () => new Date("2026-08-20T10:00:00.000Z"),
        }),
      );
      store.close();

      const csv = exportProvenance({ caseId: null, format: "csv", env: process.env }).toString("utf8");
      const lines = csv.split("\n");
      assert.equal(lines.length, 2);
      assert.match(lines[1]!, /,output_gate,rejected,human,,"/);
      assert.ok(lines[1]!.endsWith("rejected")); // 审批结论列 = verdict
    } finally {
      if (original === undefined) delete process.env.SATI_PROVENANCE_DIR;
      else process.env.SATI_PROVENANCE_DIR = original;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
