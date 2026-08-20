import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PipelineState, StageProvider } from "../../src/patent/atoms/handler.js";
import { ClaimEmbodimentMapperHandler } from "../../src/patent/atoms/handlers/builtin/mapper.js";

function state(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    source_text: "交底书：实施例 1 提供一种温控装置，含加热模块与风扇；实施例 2 增加湿度检测。",
    claims_draft: "1. 一种温控装置，其特征在于，包括加热模块。\n2. 如权利要求1所述的装置，其特征在于，还包括风扇。",
    ...overrides,
  };
}

function provider(callLLM: StageProvider["callLLM"], caseId?: string): StageProvider {
  return { ...(caseId !== undefined ? { caseId } : {}), callLLM };
}

const handler = new ClaimEmbodimentMapperHandler();

test("正常抽取：矩阵 + 确定性校验写入 state，落盘 outputs/claim-embodiment-coverage.json", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mapper-"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const result = await handler.execute({
      state: state(),
      provider: provider(
        async () =>
          JSON.stringify({
            claims: [
              { claimId: "claim_1", features: ["加热模块"], embodimentRefs: ["embodiment_1"] },
              { claimId: "claim_2", features: ["风扇"], embodimentRefs: ["embodiment_2"] },
            ],
          }),
        "case-1",
      ),
    });
    assert.equal(result._error, undefined);
    const raw = result.claim_coverage_result as string;
    const parsed = JSON.parse(raw) as { claims: Array<{ coverage: string }>; check: { missingEmbodiment: unknown[] } };
    assert.equal(parsed.claims.length, 2);
    assert.equal(parsed.claims[0]!.coverage, "full");
    assert.deepEqual(parsed.check.missingEmbodiment, []);
    // 落盘（有 caseId）
    assert.ok(existsSync(join(cwd, "data/cases/case-1/outputs/claim-embodiment-coverage.json")));
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("骨架交叉校验：引用交底书中不存在的实施例 → 剔除 → 特征判为无支撑", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mapper-skeleton-"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const result = await handler.execute({
      state: state(),
      provider: provider(
        async () =>
          JSON.stringify({
            claims: [{ claimId: "claim_1", features: ["加热模块", "风扇"], embodimentRefs: ["embodiment_99"] }],
          }),
        "case-1",
      ),
    });
    const parsed = JSON.parse(result.claim_coverage_result as string) as {
      claims: Array<{ embodimentRefs: string[]; uncoveredFeatures: string[] }>;
      check: { missingEmbodiment: Array<{ claimId: string; feature: string }> };
    };
    assert.deepEqual(parsed.claims[0]!.embodimentRefs, []);
    assert.deepEqual(parsed.claims[0]!.uncoveredFeatures, ["加热模块", "风扇"]);
    assert.equal(parsed.check.missingEmbodiment.length, 2);
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("parse 失败（非 JSON）：保留原文不降级（extract 骨架行为）", async () => {
  const result = await handler.execute({
    state: state(),
    provider: provider(async () => "这不是 JSON，是 LLM 的兜底输出", "case-1"),
  });
  assert.equal(result._error, undefined);
  assert.equal(result.claim_coverage_result, "这不是 JSON，是 LLM 的兜底输出");
});

test("LLM 调用异常：降级（_error，fail-open）", async () => {
  const result = await handler.execute({
    state: state(),
    provider: provider(async () => {
      throw new Error("模型超时");
    }, "case-1"),
  });
  assert.ok(typeof result._error === "string" && result._error.includes("模型超时"));
});

test("输入缺失（claims_draft 为空）：降级不阻断", async () => {
  const result = await handler.execute({
    state: state({ claims_draft: "  " }),
    provider: provider(async () => "{}", "case-1"),
  });
  assert.ok(typeof result._error === "string");
});

test("无 caseId：不落盘（跳过，claim-chart 先例）", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "mapper-nocase-"));
  const originalCwd = process.cwd();
  process.chdir(cwd);
  try {
    const result = await handler.execute({
      state: state(),
      provider: provider(async () => JSON.stringify({ claims: [] })),
    });
    assert.equal(result._error, undefined);
    // 无 caseId → 临时 cwd 下不产生任何落盘副作用
    assert.equal(existsSync(join(cwd, "data/cases")), false);
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("空矩阵（评审 I3）：返回 claims_empty 标记而非静默无缺口", async () => {
  const result = await handler.execute({
    state: state(),
    provider: provider(async () => JSON.stringify({ claims: [] })),
  });
  assert.equal(result._error, undefined);
  const parsed = JSON.parse(result.claim_coverage_result as string) as { claims_empty: boolean };
  assert.equal(parsed.claims_empty, true);
});

test("LLM 漏项（评审 I1）：claims_draft 存在但矩阵缺失的编号并入 missingClaims", async () => {
  const result = await handler.execute({
    state: state(), // claims_draft 含 claim_1、claim_2
    provider: provider(async () =>
      JSON.stringify({ claims: [{ claimId: "claim_1", features: ["加热模块"], embodimentRefs: ["embodiment_1"] }] }),
    ),
  });
  const parsed = JSON.parse(result.claim_coverage_result as string) as { missingClaims: string[] };
  assert.deepEqual(parsed.missingClaims, ["claim_2"]);
});

test("幻觉引用（评审 I2）：骨架剔除的 refs 记入 droppedRefs（可见而非静默）", async () => {
  const result = await handler.execute({
    state: state(), // source_text 无「实施例 99」
    provider: provider(async () =>
      JSON.stringify({
        claims: [{ claimId: "claim_1", features: ["加热模块"], embodimentRefs: ["embodiment_99", "embodiment_1"] }],
      }),
    ),
  });
  const parsed = JSON.parse(result.claim_coverage_result as string) as {
    claims: Array<{ embodimentRefs: string[] }>;
    droppedRefs: string[];
  };
  assert.deepEqual(parsed.claims[0]!.embodimentRefs, ["embodiment_1"]); // 合法引用保留
  assert.deepEqual(parsed.droppedRefs, ["embodiment_99"]); // 幻觉引用可见
});

test("重复 claimId（评审 M3）：按 claimId 去重保留首条，不误报跨权项重复", async () => {
  const result = await handler.execute({
    state: state(),
    provider: provider(async () =>
      JSON.stringify({
        claims: [
          { claimId: "claim_1", features: ["加热模块"], embodimentRefs: ["embodiment_1"] },
          { claimId: "claim_1", features: ["风扇"], embodimentRefs: ["embodiment_2"] },
        ],
      }),
    ),
  });
  const parsed = JSON.parse(result.claim_coverage_result as string) as {
    claims: Array<{ features: string[] }>;
    check: { duplicateFeatures: string[] };
  };
  assert.equal(parsed.claims.length, 1);
  assert.deepEqual(parsed.claims[0]!.features, ["加热模块"]);
  assert.deepEqual(parsed.check.duplicateFeatures, []);
});
