import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendInventivenessFeedback,
  loadInventivenessFeedback,
  summarizeInventivenessFeedback,
  caseInventivenessFeedbackPath,
  caseSessionBindingPath,
  saveSessionCaseBinding,
  findCaseIdBySession,
  type InventivenessFeedbackRecord,
} from "../../../src/patent/index.js";

const record = (overrides: Partial<InventivenessFeedbackRecord> = {}): InventivenessFeedbackRecord => ({
  caseId: "case-1",
  originalOutputPreview: "三步法分析报告：具备创造性。",
  verdict: "rejected",
  feedback: "区别特征认定不准确，D1 已公开该特征",
  decidedAt: "2026-08-18T00:00:00.000Z",
  ...overrides,
});

test("append → load 闭环：JSONL 追加与读取（P2-4）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-feedback-"));
  try {
    const file = join(dir, caseInventivenessFeedbackPath("case-1"));
    await appendInventivenessFeedback(file, record());
    await appendInventivenessFeedback(file, record({ verdict: "modified", feedback: "补充实际解决的技术问题" }));
    const loaded = await loadInventivenessFeedback(file);
    assert.equal(loaded.length, 2);
    assert.equal(loaded[0]!.verdict, "rejected");
    assert.equal(loaded[0]!.feedback, "区别特征认定不准确，D1 已公开该特征");
    assert.equal(loaded[1]!.verdict, "modified");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load: 文件不存在返回空数组", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-feedback-missing-"));
  try {
    const loaded = await loadInventivenessFeedback(join(dir, "nope.jsonl"));
    assert.deepEqual(loaded, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("load: 坏行跳过（并发写半行容忍）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-feedback-parse-"));
  try {
    const file = join(dir, "f.jsonl");
    await appendInventivenessFeedback(file, record());
    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, "{bad json\n");
    const loaded = await loadInventivenessFeedback(file);
    assert.equal(loaded.length, 1, "坏行应被跳过");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("summarize: 生成'历史人工反馈'提示文本（最多 5 条，空记录返回空串）", () => {
  assert.equal(summarizeInventivenessFeedback([]), "");
  const summary = summarizeInventivenessFeedback([record(), record({ verdict: "modified", feedback: "ok" })]);
  assert.ok(summary.includes("历史人工反馈"), "应含提示标题");
  assert.ok(summary.includes("区别特征认定不准确"), "应含反馈内容");
  assert.ok(summary.includes("rejected") && summary.includes("modified"), "应标注判定");
  // 最多汇总 5 条。
  const many = Array.from({ length: 7 }, (_, i) => record({ feedback: `f${i}` }));
  const s7 = summarizeInventivenessFeedback(many);
  assert.ok(!s7.includes("f0"), "超过 5 条只汇总最近 5 条");
  assert.ok(s7.includes("f6"), "应含最近一条");
});

test("caseInventivenessFeedbackPath: 路径约定 data/cases/<caseId>/inventiveness-feedback.jsonl", () => {
  assert.equal(caseInventivenessFeedbackPath("case-9"), "data/cases/case-9/inventiveness-feedback.jsonl");
});

test("session 绑定：save → find 反查命中（P2-4 写侧半桥）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-binding-"));
  try {
    const root = join(dir, "data", "cases");
    const bindingPath = join(root, "case-a", "workflow-runs", "session-binding.json");
    await saveSessionCaseBinding(bindingPath, { sessionId: "sess-1", boundAt: "2026-08-30T00:00:00.000Z" });
    const caseId = await findCaseIdBySession(root, "sess-1");
    assert.equal(caseId, "case-a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session 绑定：last-write-wins（多 case 绑定同 session 时取 boundAt 最新，与目录遍历序无关）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-binding-lww-"));
  try {
    const root = join(dir, "data", "cases");
    await saveSessionCaseBinding(join(root, "case-a", "workflow-runs", "session-binding.json"), {
      sessionId: "sess-1",
      boundAt: "2026-08-30T00:00:00.000Z",
    });
    await saveSessionCaseBinding(join(root, "case-b", "workflow-runs", "session-binding.json"), {
      sessionId: "sess-1",
      boundAt: "2026-08-30T01:00:00.000Z",
    });
    assert.equal(await findCaseIdBySession(root, "sess-1"), "case-b", "归 boundAt 最新的 case");
    // 再绑第三个更晚的 case → 反查跟随最新。
    await saveSessionCaseBinding(join(root, "case-c", "workflow-runs", "session-binding.json"), {
      sessionId: "sess-1",
      boundAt: "2026-08-30T02:00:00.000Z",
    });
    assert.equal(await findCaseIdBySession(root, "sess-1"), "case-c");
    // 缺 boundAt 的旧式绑定视为最旧，不抢占。
    await saveSessionCaseBinding(join(root, "case-d", "workflow-runs", "session-binding.json"), {
      sessionId: "sess-1",
      boundAt: "",
    });
    assert.equal(await findCaseIdBySession(root, "sess-1"), "case-c");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("session 绑定：cases 根不存在 / 无命中 / 坏 JSON → undefined（fail-open）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "invent-binding-miss-"));
  try {
    const root = join(dir, "data", "cases");
    assert.equal(await findCaseIdBySession(root, "sess-1"), undefined, "根目录不存在 → undefined");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    mkdirSync(join(root, "case-x", "workflow-runs"), { recursive: true });
    writeFileSync(join(root, "case-x", "workflow-runs", "session-binding.json"), "{bad json");
    assert.equal(await findCaseIdBySession(root, "sess-1"), undefined, "坏 JSON 跳过 → undefined");
    mkdirSync(join(root, "case-y", "workflow-runs"), { recursive: true });
    writeFileSync(
      join(root, "case-y", "workflow-runs", "session-binding.json"),
      JSON.stringify({ sessionId: "other", boundAt: "2026-08-30T00:00:00.000Z" }),
    );
    assert.equal(await findCaseIdBySession(root, "sess-1"), undefined, "session 不匹配 → undefined");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caseSessionBindingPath: 路径约定 data/cases/<caseId>/workflow-runs/session-binding.json", () => {
  assert.equal(caseSessionBindingPath("case-1"), "data/cases/case-1/workflow-runs/session-binding.json");
});
