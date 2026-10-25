import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

// dist/tests/patent/evidence → 仓库根；读源文件以校验拆分边界，而非编译产物。
const EVIDENCE_DIR = join(resolve(import.meta.dirname, "../../../.."), "src/patent/evidence");

async function source(name: string): Promise<string> {
  return readFile(join(EVIDENCE_DIR, name), "utf8");
}

async function lineCount(name: string): Promise<number> {
  const text = await source(name);
  return text.trimEnd().split("\n").length;
}

test("evidence/engine.ts 只保留编排层（< 300 行）", async () => {
  const count = await lineCount("engine.ts");
  assert.ok(count < 300, `engine.ts 应 < 300 行，实际 ${count} 行`);
});

test("evidence/engine.ts 不再重复定义已迁出的模块函数", async () => {
  const text = await source("engine.ts");
  const moved = [
    "inferEvidenceType",
    "evaluateTypeSpecific",
    "evaluateFourElements",
    "parseRuleSet",
    "evaluateCondition",
    "evaluateRelevance",
    "computeOverallScore",
  ];
  for (const name of moved) {
    assert.doesNotMatch(text, new RegExp(`function ${name}\\b`), `${name} 应只在独立模块定义`);
  }
});

test("拆分后的子模块各自导出唯一职责入口", async () => {
  const expected: Array<[string, string]> = [
    ["judgment.ts", "export function evaluateRelevance"],
    ["type-inference.ts", "export function inferEvidenceType"],
    ["four-elements.ts", "export function evaluateFourElements"],
    ["rule-evaluation.ts", "export function parseRuleSet"],
  ];
  for (const [file, marker] of expected) {
    assert.ok((await source(file)).includes(marker), `${file} 应导出 ${marker.replace("export function ", "")}`);
  }
});
