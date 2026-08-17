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
