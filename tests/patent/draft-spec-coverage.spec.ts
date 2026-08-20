import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineState, StageProvider } from "../../src/patent/atoms/handler.js";
import { DraftSpecHandler } from "../../src/patent/atoms/handlers/builtin/draft.js";

const handler = new DraftSpecHandler();

/** 完整七部分说明书 JSON（validateDraftSpec passed=true）。 */
const SPEC_JSON = JSON.stringify({
  title: "一种双层真空保温容器",
  sections: [
    { name: "技术领域", content: "本发明涉及保温容器技术领域。" },
    { name: "背景技术", content: "D1（CN1234567A）保温时间短。" },
    {
      name: "发明内容",
      content: "要解决的技术问题是保温时间短；技术方案为双层真空结构；有益效果：保温时间由 2 小时提升至 8 小时。",
    },
    { name: "附图说明", content: "图1为整体结构示意图。" },
    { name: "具体实施方式", content: "实施例1：真空度 0.1Pa，保温 8 小时。" },
    { name: "摘要", content: "本发明提供一种双层真空保温容器。" },
  ],
});

function runWithCoverageResult(coverageResult: string): Promise<PipelineState> {
  const provider: StageProvider = {
    callLLM: async () => SPEC_JSON,
  };
  return handler.execute({
    state: {
      source_text: "交底书。实施例 1：真空度 0.1Pa。",
      claims_draft: "1. 一种装置。",
      claim_coverage_result: coverageResult,
    },
    provider,
  });
}

function parseSpecValidation(result: PipelineState): {
  passed: boolean;
  violations: Array<{ rule: string; severity: string; message: string }>;
} {
  return JSON.parse(result.spec_validation as string) as {
    passed: boolean;
    violations: Array<{ rule: string; severity: string; message: string }>;
  };
}

test("missingEmbodiment → 追加 warning 且 passed 不翻转", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await runWithCoverageResult(
      JSON.stringify({
        claims: [{ claimId: "claim_1", features: ["双层真空结构"], embodimentRefs: [] }],
        check: { missingEmbodiment: [{ claimId: "claim_1", feature: "双层真空结构" }] },
      }),
    );
    const validation = parseSpecValidation(result);
    assert.equal(validation.passed, true); // warning 不翻转 passed
    const coverage = validation.violations.filter(v => v.rule === "claim_embodiment_coverage");
    assert.equal(coverage.length, 1);
    assert.equal(coverage[0]!.severity, "warning");
    assert.match(coverage[0]!.message, /双层真空结构/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claim_coverage_result 缺失 → 无追加（fail-open）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await handler.execute({
      state: { source_text: "交底书", claims_draft: "1. 一种装置。" },
      provider: { callLLM: async () => SPEC_JSON },
    });
    const validation = parseSpecValidation(result);
    assert.equal(
      validation.violations.some(v => v.rule === "claim_embodiment_coverage"),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claim_coverage_result 非 JSON（mapper parse 失败保留原文）→ 跳过", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await runWithCoverageResult("这不是 JSON");
    const validation = parseSpecValidation(result);
    assert.equal(
      validation.violations.some(v => v.rule === "claim_embodiment_coverage"),
      false,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("missingClaims（LLM 漏项）→ 追加对应 warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await runWithCoverageResult(
      JSON.stringify({ claims: [], check: { missingEmbodiment: [] }, missingClaims: ["claim_2"] }),
    );
    const validation = parseSpecValidation(result);
    const hit = validation.violations.find(v => v.rule === "claim_coverage_missing_claim");
    assert.ok(hit !== undefined);
    assert.match(hit!.message, /claim_2/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("claims_empty → 追加空矩阵 warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await runWithCoverageResult(
      JSON.stringify({ claims: [], check: { missingEmbodiment: [] }, claims_empty: true }),
    );
    const validation = parseSpecValidation(result);
    const hit = validation.violations.find(v => v.rule === "claim_coverage_empty");
    assert.ok(hit !== undefined);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("droppedRefs（幻觉引用）→ 追加对应 warning", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "draft-coverage-"));
  try {
    const result = await runWithCoverageResult(
      JSON.stringify({ claims: [], check: { missingEmbodiment: [] }, droppedRefs: ["embodiment_99"] }),
    );
    const validation = parseSpecValidation(result);
    const hit = validation.violations.find(v => v.rule === "claim_coverage_dropped_refs");
    assert.ok(hit !== undefined);
    assert.match(hit!.message, /embodiment_99/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
