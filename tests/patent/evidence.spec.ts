import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaimBinding,
  ConflictDetector,
  EvidenceExtension,
  Ledger,
  contentHash,
  createSpan,
  isLocatable,
  receiptFromToolExecution,
  type EvidenceSpan,
} from "../../src/patent/index.js";

// ---------------------------------------------------------------------------
// EvidenceSpan 工厂与可定位性
// ---------------------------------------------------------------------------

test("createSpan：缺省生成 id，四元组定位信息可校验", () => {
  const span = createSpan({
    docVersion: "v1.0",
    pageRange: "第3页第15-20行",
    charRange: "1200-1250",
    contentHash: "abc123",
    snippet: "原文摘录",
    direction: "supporting",
  });
  assert.match(span.id, /^span-/);
  assert.equal(span.direction, "supporting");
  assert.equal(isLocatable(span), true);
});

test("isLocatable：无任何定位信息时为 false", () => {
  const span = createSpan({ snippet: "只有摘录", direction: "neutral" });
  assert.equal(isLocatable(span), false);
});

// ---------------------------------------------------------------------------
// Receipt 与 Ledger
// ---------------------------------------------------------------------------

test("receiptFromToolExecution：提取 path 与写分类", () => {
  const r = receiptFromToolExecution({
    toolCallId: "call-1",
    turnId: "turn-1",
    toolName: "write_file",
    args: { path: "/tmp/a.md", content: "x" },
    success: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    resultText: "已写入",
  });
  assert.equal(r.path, "/tmp/a.md");
  assert.equal(r.write, true);
  assert.equal(r.toolName, "write_file");
  assert.equal(r.success, true);
});

test("receiptFromToolExecution：读工具标记 write=false，结果超长截断", () => {
  const r = receiptFromToolExecution({
    toolCallId: "call-2",
    turnId: "turn-1",
    toolName: "read_file",
    args: { path: "/tmp/b.md" },
    success: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    resultText: "x".repeat(5000),
  });
  assert.equal(r.write, false);
  assert.ok((r.resultText?.length ?? 0) <= 2000);
});

test("Ledger：按 turn 重置，按工具检索", () => {
  const real = new Ledger();
  real.record(
    receiptFromToolExecution({
      toolCallId: "a",
      turnId: "t1",
      toolName: "read_file",
      args: {},
      success: true,
      startedAt: "x",
    }),
  );
  real.record(
    receiptFromToolExecution({
      toolCallId: "b",
      turnId: "t1",
      toolName: "write_file",
      args: { path: "/p" },
      success: true,
      startedAt: "x",
    }),
  );
  assert.equal(real.size(), 2);
  assert.equal(real.byTool("read_file").length, 1);
  real.reset();
  assert.equal(real.size(), 0);
});

// ---------------------------------------------------------------------------
// ClaimBinding：无证据支持结论
// ---------------------------------------------------------------------------

test("ClaimBinding：unbackedClaims 列出无证据结论，空集合返回空数组", () => {
  const binding = new ClaimBinding();
  binding.bind("claim-1", "span-1");
  assert.deepEqual(binding.unbackedClaims(["claim-1", "claim-2"]), ["claim-2"]);
  assert.deepEqual(binding.unbackedClaims([]), []);
  // 解绑后变回无证据
  binding.unbind("claim-1", "span-1");
  assert.deepEqual(binding.unbackedClaims(["claim-1"]), ["claim-1"]);
});

// ---------------------------------------------------------------------------
// ConflictDetector：两类冲突
// ---------------------------------------------------------------------------

test("ConflictDetector：同一结论同时有支持+矛盾证据 → claim 冲突", () => {
  const detector = new ConflictDetector();
  const spansById = new Map<string, EvidenceSpan>([
    ["s1", createSpan({ id: "s1", direction: "supporting", sourceUri: "file:///a" })],
    ["s2", createSpan({ id: "s2", direction: "contradicting", sourceUri: "file:///b" })],
  ]);
  const spansByClaim = new Map([["claim-1", ["s1", "s2"]]]);
  const conflicts = detector.detect({ claimIds: ["claim-1"], spansByClaim, spansById });
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]?.type, "claim");
  assert.equal(conflicts[0]?.subject, "claim-1");
});

test("ConflictDetector：同源证据方向矛盾 → source 冲突", () => {
  const detector = new ConflictDetector();
  const spansById = new Map<string, EvidenceSpan>([
    ["s1", createSpan({ id: "s1", direction: "supporting", sourceUri: "file:///same" })],
    ["s2", createSpan({ id: "s2", direction: "contradicting", sourceUri: "file:///same" })],
  ]);
  const conflicts = detector.detect({ claimIds: ["c1"], spansByClaim: new Map(), spansById });
  const sourceConflicts = conflicts.filter(c => c.type === "source");
  assert.equal(sourceConflicts.length, 1);
  assert.equal(sourceConflicts[0]?.subject, "file:///same");
});

test("ConflictDetector：无矛盾时不报冲突", () => {
  const detector = new ConflictDetector();
  const spansById = new Map<string, EvidenceSpan>([
    ["s1", createSpan({ id: "s1", direction: "supporting", sourceUri: "file:///a" })],
    ["s2", createSpan({ id: "s2", direction: "supporting", sourceUri: "file:///b" })],
  ]);
  const spansByClaim = new Map([["c1", ["s1", "s2"]]]);
  assert.deepEqual(detector.detect({ claimIds: ["c1"], spansByClaim, spansById }), []);
});

// ---------------------------------------------------------------------------
// EvidenceExtension：端到端闭环
// ---------------------------------------------------------------------------

test("EvidenceExtension：Receipt 入账 → 提升证据 → 绑定 → 无证据/冲突查询", () => {
  const ext = new EvidenceExtension();
  ext.startTurn();

  // 工具自动收集
  ext.recordReceipt({
    toolCallId: "call-1",
    turnId: "turn-1",
    toolName: "read_file",
    args: { path: "/docs/a.md" },
    success: true,
    startedAt: "2026-01-01T00:00:00.000Z",
    resultText: "对比文件 D1 公开了特征 X",
    write: false,
    path: "/docs/a.md",
  });
  assert.equal(ext.ledger.size(), 1);

  // Receipt 提升为证据（sourceUri/contentHash 自动生成）
  const receipt = ext.ledger.list()[0]!;
  const span = ext.spanFromReceipt(receipt, "supporting", "D1 公开了特征 X");
  assert.equal(span.sourceUri, "file:///docs/a.md");
  assert.ok(span.contentHash);
  assert.equal(ext.getSpan(span.id), span);

  // 绑定结论
  ext.bind("conclusion-1", span.id);
  assert.deepEqual(ext.unbackedClaims(["conclusion-1", "conclusion-2"]), ["conclusion-2"]);
  assert.match(ext.unbackedNotice(["conclusion-1", "conclusion-2"]) ?? "", /conclusion-2/);
  assert.equal(ext.unbackedNotice(["conclusion-1"]), undefined);

  // 冲突检测（加入矛盾证据）
  const contradicting = ext.spanFromReceipt(
    { ...receipt, toolCallId: "call-2", resultText: "D1 未公开特征 X" },
    "contradicting",
  );
  ext.bind("conclusion-1", contradicting.id);
  const conflicts = ext.detectConflicts(["conclusion-1"]);
  assert.equal(
    conflicts.some(c => c.type === "claim" && c.subject === "conclusion-1"),
    true,
  );

  // startTurn 重置账本（跨 turn 不泄漏），证据/绑定保留
  ext.startTurn();
  assert.equal(ext.ledger.size(), 0);
  assert.equal(ext.getSpan(span.id)?.id, span.id);
});

test("contentHash 稳定且区分内容", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.match(contentHash("x"), /^[0-9a-f]{1,8}$/);
});
