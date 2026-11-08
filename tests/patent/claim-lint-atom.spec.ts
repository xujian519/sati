/**
 * claim-lint 原子（#830 M4）—— 确定性校验门原子的契约测试。
 *
 * 覆盖：输出结构（gaps/consistent 供 workflow 结构化回退判据）、修订提示
 * （证据型、不含门限数字）、主输出键契约、输入为空时的显式降级。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaimLintHandler, buildClaimLintRevisionHint } from "../../src/patent/atoms/handlers/builtin/claimLint.js";
import { claimLintAtom } from "../../src/patent/atoms/handlers/builtin/claimLint.js";

const CLEAN_CLAIMS = [
  "1. 一种数据处理方法，其特征在于，包括：获取输入数据；对所述输入数据进行处理，得到处理结果。",
  "2. 根据权利要求1所述的数据处理方法，其特征在于，所述处理包括降噪。",
].join("\n\n");

const BROKEN_CLAIMS = ["1. 一种数据处理方法，其特征在于，包括：获取输入数据；温度约为50℃。"].join("\n\n");

describe("claim-lint 原子", () => {
  it("主输出键声明符合契约（outputSchema[0] 为 report）", () => {
    const handler = new ClaimLintHandler();
    assert.equal(handler.name, "claim-lint");
    assert.equal(handler.category, "gate");
    // workflow 以 outputSchema[0] 取阶段主输出（见 workflow/executor.ts）：
    // 主键必须落在 outputSchema 内，否则阶段输出为空、被判降级。
    assert.equal(claimLintAtom.outputSchema[0], "claim_lint_report");
    assert.ok(claimLintAtom.outputSchema.includes("claim_lint_result"));
  });

  it("干净权要：passed=true、consistent=true、无 gaps", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: { claims_draft: CLEAN_CLAIMS } });
    const result = JSON.parse(segment.claim_lint_result as string) as {
      consistent: boolean;
      gaps: unknown[];
      passed: boolean;
      errorCount: number;
    };
    assert.equal(result.passed, true);
    assert.equal(result.consistent, true);
    assert.deepEqual(result.gaps, []);
    assert.equal(result.errorCount, 0);
    assert.match(segment.claim_lint_report as string, /✅ 通过/);
  });

  it("存在 error：consistent=false、gaps 非空、可被结构化判据捕获", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: { claims_draft: BROKEN_CLAIMS } });
    const result = JSON.parse(segment.claim_lint_result as string) as {
      consistent: boolean;
      gaps: Array<{ id: string }>;
      passed: boolean;
    };
    assert.equal(result.passed, false);
    assert.equal(result.consistent, false);
    assert.ok(result.gaps.length > 0);
    assert.ok(result.gaps.some(gap => gap.id.startsWith("uncertain-term")));
  });

  it("输出为严格 JSON（含 gaps 与 consistent 键）——workflow 结构化判据前提", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: { claims_draft: BROKEN_CLAIMS } });
    const raw = segment.claim_lint_result as string;
    assert.ok(raw.trim().startsWith("{") && raw.trim().endsWith("}"));
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    assert.ok("gaps" in parsed);
    assert.ok("consistent" in parsed);
  });

  it("有 error 时产出证据型修订提示，且不含门限数字断言", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: { claims_draft: BROKEN_CLAIMS } });
    const hint = segment.claim_lint_revision_hint as string;
    assert.ok(hint, "应产出修订提示");
    assert.match(hint, /uncertain-term/);
    // 断言安全：提示不得含分数/通过线式数字断言。
    assert.doesNotMatch(hint, /通过线|总分|\d+\s*分/);
  });

  it("通过时不产出修订提示（避免语义噪音）", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: { claims_draft: CLEAN_CLAIMS } });
    assert.equal(segment.claim_lint_revision_hint, undefined);
  });

  it("输入为空：显式降级，不冒充通过", async () => {
    const handler = new ClaimLintHandler();
    const segment = await handler.execute({ state: {} });
    const result = JSON.parse(segment.claim_lint_result as string) as {
      passed: boolean;
      degraded: boolean;
    };
    assert.equal(result.passed, false);
    assert.equal(result.degraded, true);
  });

  it("修订提示构造器：无证据时返回 undefined", () => {
    assert.equal(buildClaimLintRevisionHint([]), undefined);
  });
});
