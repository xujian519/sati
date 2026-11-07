/**
 * #830 M3：claim-strategy 原子 + 从权树渲染。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  ClaimStrategyHandler,
  DraftClaimsHandler,
  buildClaimTree,
  normalizeClaimStrategy,
  renderClaimsFromStrategy,
  type ClaimStrategy,
} from "../../src/patent/atoms/handlers/builtin/draft.js";

const STRATEGY: ClaimStrategy = {
  subject: "一种分拣装置",
  independentFeatures: ["传送带", "识别传感器"],
  dependentClaims: [
    { dependsOn: [1], features: ["所述传送带为皮带"] },
    { dependsOn: [2], features: ["所述识别传感器为视觉传感器"] },
  ],
};

test("renderClaimsFromStrategy：独权在前，从权按依赖引用前序权项", () => {
  const { claims, tree } = renderClaimsFromStrategy(STRATEGY);
  assert.equal(claims[0], "1. 一种分拣装置，其特征在于，传送带，识别传感器。");
  assert.equal(claims[1], "2. 根据权利要求1所述的分拣装置，其特征在于，所述传送带为皮带。");
  assert.equal(claims[2], "3. 根据权利要求2所述的分拣装置，其特征在于，所述识别传感器为视觉传感器。");
  assert.deepEqual(
    tree.map(node => node.claimNo),
    [1, 2, 3],
  );
  assert.equal(tree[1]!.type, "dependent");
});

test("buildClaimTree：非法依赖回退到独权，禁止引用后序权项", () => {
  const tree = buildClaimTree({
    subject: "一种装置",
    independentFeatures: ["A"],
    dependentClaims: [{ dependsOn: [5], features: ["B"] }],
  });
  assert.deepEqual(tree[1]!.dependsOn, [1]);
});

test("renderClaimsFromStrategy：空特征不渲染空的特征在于从句", () => {
  const { claims } = renderClaimsFromStrategy({
    subject: "一种装置",
    independentFeatures: ["A"],
    dependentClaims: [{ dependsOn: [1], features: [] }],
  });
  // 空特征从权被跳过，仅渲染独权。
  assert.equal(claims.length, 1);
});

test("normalizeClaimStrategy：结构不合法返回 null（不渲染半成品）", () => {
  assert.equal(normalizeClaimStrategy(null), null);
  assert.equal(normalizeClaimStrategy({ subject: "", independent_features: ["A"] }), null);
  assert.equal(normalizeClaimStrategy({ subject: "一种装置", independent_features: [] }), null);
  assert.equal(normalizeClaimStrategy({ subject: "一种装置", independent_features: ["A"] }) !== null, true);
  // snake_case 与 camelCase 均接受
  const camel = normalizeClaimStrategy({
    subject: "一种装置",
    independentFeatures: ["A"],
    dependentClaims: [{ dependsOn: [1], features: ["B"] }],
  });
  assert.equal(camel?.dependentClaims[0]?.dependsOn[0], 1);
});

test("ClaimStrategyHandler：LLM 输出策略表 → claims_strategy + claims_tree", async () => {
  const handler = new ClaimStrategyHandler();
  const result = await handler.execute({
    state: { source_text: "一种分拣装置，包括传送带与识别传感器" },
    provider: {
      callLLM: async () => JSON.stringify(STRATEGY),
    },
  });
  assert.equal(result._error, undefined);
  const strategy = JSON.parse(String(result.claims_strategy)) as ClaimStrategy;
  assert.equal(strategy.subject, "一种分拣装置");
  const tree = JSON.parse(String(result.claims_tree)) as Array<{ claimNo: number }>;
  assert.equal(tree.length, 3);
});

test("ClaimStrategyHandler：非 JSON 输出 → 显式降级（不静默）", async () => {
  const handler = new ClaimStrategyHandler();
  const result = await handler.execute({
    state: { source_text: "一种分拣装置" },
    provider: { callLLM: async () => "抱歉，我无法给出策略" },
  });
  assert.match(String(result._error), /无法解析为权利要求布局策略表/);
});

test("DraftClaimsHandler：有策略表时确定性渲染，无需 LLM", async () => {
  const handler = new DraftClaimsHandler();
  const result = await handler.execute({
    state: { claims_strategy: JSON.stringify(STRATEGY) },
    provider: {},
  });
  assert.equal(result._error, undefined);
  assert.match(String(result.claims_draft), /^1\. 一种分拣装置/);
  assert.match(String(result.claims_draft), /根据权利要求1所述的分拣装置/);
  assert.ok(String(result.claims_tree).includes('"type":"dependent"'));
});

test("DraftClaimsHandler：策略表损坏 → 回退旧路径并留痕", async () => {
  const handler = new DraftClaimsHandler();
  const result = await handler.execute({
    state: { claims_strategy: "{not-json", source_text: "一种分拣装置" },
    provider: {
      callLLM: async () => JSON.stringify({ claims: ["1. 一种分拣装置，其特征在于，包括传送带。"], notes: "旧路径" }),
    },
  });
  assert.match(String(result.claims_draft), /^1\. 一种分拣装置/);
  assert.match(String(result.claim_strategy_ignored), /回退单次 LLM/);
});

test("DraftClaimsHandler：无策略表时行为与旧版一致", async () => {
  const handler = new DraftClaimsHandler();
  const result = await handler.execute({
    state: { source_text: "一种分拣装置" },
    provider: {
      callLLM: async () => JSON.stringify({ claims: ["1. 一种分拣装置，其特征在于，包括传送带。"] }),
    },
  });
  assert.equal(result.claim_strategy_ignored, undefined);
  assert.equal(result.claims_tree, undefined);
  assert.match(String(result.claims_draft), /包括传送带/);
});
