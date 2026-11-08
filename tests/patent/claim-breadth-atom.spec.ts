/**
 * claim-breadth 原子（#830 M2）—— A26.4 判定原子的契约测试。
 *
 * 覆盖：两阶段接线（交底预评估 / 草稿复核）、结论缺失不冒充通过、
 * 主输出键契约（workflow 以 outputSchema[0] 为主输出）。
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ClaimBreadthHandler, claimBreadthAtom } from "../../src/patent/atoms/handlers/builtin/claimBreadth.js";
import type { StageProvider } from "../../src/patent/atoms/handler.js";

/** mock provider：按 A26.4 子图四个 LLM 节点的 prompt 特征返回 JSON。 */
function breadthProvider(overrides: { conclusion?: string } = {}): StageProvider {
  return {
    async callLLM(prompt: string): Promise<string> {
      if (prompt.includes("第一步：权利要求是否清楚")) return JSON.stringify({ issues: [], clarity_ok: true });
      if (prompt.includes("第二步：权利要求是否以说明书为依据")) return JSON.stringify({ gaps: [], support_ok: true });
      if (prompt.includes("第三步：功能性限定是否过宽")) return JSON.stringify({ overbroad: false, issues: [] });
      if (prompt.includes("综合三步审查")) {
        return (
          overrides.conclusion ??
          JSON.stringify({
            support_ok: true,
            clarity_ok: true,
            gaps: [],
            confidence: "high",
            key_rationale: "权要特征在说明书中均有对应公开",
            report: "A26.4 审查通过。",
          })
        );
      }
      return "默认结论";
    },
    async search() {
      return [];
    },
  };
}

const CLAIM = "1. 一种双层真空保温容器，其特征在于，包括内胆、外壳与真空隔热层。";
const SPEC = "本发明提供一种双层真空保温容器，包括内胆、外壳与真空隔热层。真空隔热层的真空度为0.1Pa。";

describe("claim-breadth 原子", () => {
  it("主输出键声明符合契约（outputSchema[0] 为 report）", () => {
    const handler = new ClaimBreadthHandler();
    assert.equal(handler.name, "claim-breadth");
    // workflow 以 outputSchema[0] 取阶段主输出：主键必须落在 outputSchema 内。
    assert.equal(claimBreadthAtom.outputSchema[0], "claim_breadth_report");
    assert.ok(claimBreadthAtom.outputSchema.includes("claim_breadth_result"));
  });

  it("草稿阶段复核：读 claims_draft，phase=review", async () => {
    const handler = new ClaimBreadthHandler();
    const segment = await handler.execute({
      state: { claims_draft: CLAIM, source_text: SPEC },
      provider: breadthProvider(),
    });
    const result = JSON.parse(segment.claim_breadth_result as string) as {
      status: string;
      phase: string;
      supportOk?: boolean;
      clarityOk?: boolean;
    };
    assert.equal(result.phase, "review");
    assert.equal(result.status, "completed");
    assert.equal(result.supportOk, true);
    assert.equal(result.clarityOk, true);
    assert.match(segment.claim_breadth_report as string, /草稿阶段复核/);
  });

  it("交底阶段预评估：无 claims_draft 时读策略表，phase=preview", async () => {
    const handler = new ClaimBreadthHandler();
    const segment = await handler.execute({
      state: {
        claims_strategy: JSON.stringify({
          subject: "一种双层真空保温容器",
          independent_features: ["内胆", "外壳", "真空隔热层"],
          dependent_claims: [{ depends_on: [1], features: ["真空度为0.1Pa"] }],
        }),
        source_text: SPEC,
      },
      provider: breadthProvider(),
    });
    const result = JSON.parse(segment.claim_breadth_result as string) as { phase: string };
    assert.equal(result.phase, "preview");
    assert.match(segment.claim_breadth_report as string, /交底阶段预评估/);
    // 预览结论另存 preview 键，复核阶段不覆盖它。
    assert.ok(segment.claim_breadth_preview_result !== undefined);
  });

  it("结论不可解析时不得冒充通过（supportOk/clarityOk 保持 undefined）", async () => {
    const handler = new ClaimBreadthHandler();
    const segment = await handler.execute({
      state: { claims_draft: CLAIM, source_text: SPEC },
      provider: breadthProvider({ conclusion: "这不是 JSON" }),
    });
    const result = JSON.parse(segment.claim_breadth_result as string) as {
      status: string;
      supportOk?: boolean;
      clarityOk?: boolean;
    };
    assert.equal(result.status, "degraded_no_conclusion");
    assert.equal(result.supportOk, undefined);
    assert.equal(result.clarityOk, undefined);
    assert.match(segment.claim_breadth_report as string, /未评估/);
  });

  it("输入为空：显式降级，不冒充通过", async () => {
    const handler = new ClaimBreadthHandler();
    const segment = await handler.execute({ state: {} });
    const result = JSON.parse(segment.claim_breadth_result as string) as {
      status: string;
      supportOk?: boolean;
    };
    assert.equal(result.status, "degraded_no_input");
    assert.equal(result.supportOk, undefined);
  });
});
