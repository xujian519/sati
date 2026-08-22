/**
 * src/patent/evaluate — 多模型共识判定 + Verdict Envelope（第三刀）：
 * 共识纯函数（中位/离散度/分歧）、typed verdict 审计对象（哈希防篡改）、
 * 多 judge 投票收集（fail-open）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
  buildVerdictEnvelope,
  collectJudgeVotes,
  compositeOverall,
  resolveConsensus,
  verifyVerdictEnvelope,
  type JudgeVote,
  type VerdictLayer,
} from "../../../src/patent/evaluate/index.js";

// ---------------------------------------------------------------------------
// resolveConsensus
// ---------------------------------------------------------------------------

test("resolveConsensus：空票 → undefined；单票 spread=0 按阈值判", () => {
  assert.equal(resolveConsensus([]), undefined);
  const pass = resolveConsensus([{ judgeId: "a", score: 0.85 }]);
  assert.equal(pass?.verdict, "pass");
  assert.equal(pass?.spread, 0);
  const fail = resolveConsensus([{ judgeId: "a", score: 0.5 }]);
  assert.equal(fail?.verdict, "needs_revision");
});

test("resolveConsensus：多票取中位数（偶数票取均值，与阈值比较）", () => {
  const votes: JudgeVote[] = [
    { judgeId: "a", score: 0.6 },
    { judgeId: "b", score: 0.7 },
    { judgeId: "c", score: 0.8 },
  ];
  const verdict = resolveConsensus(votes);
  assert.equal(verdict?.verdict, "pass");
  assert.equal(verdict?.median, 0.7);
  assert.equal(verdict?.spread, 0.2);
  // 偶数票：中位 = 中间两值平均（0.675 < 0.7 → needs_revision）。
  const even = resolveConsensus([
    { judgeId: "a", score: 0.8 },
    { judgeId: "b", score: 0.55 },
  ]);
  assert.equal(even?.median, 0.675);
  assert.equal(even?.verdict, "needs_revision");
});

test("resolveConsensus：极差超 spreadLimit → disagree（即使中位达标）", () => {
  const votes: JudgeVote[] = [
    { judgeId: "a", score: 0.95 },
    { judgeId: "b", score: 0.6 },
  ];
  const verdict = resolveConsensus(votes, { spreadLimit: 0.25 });
  assert.equal(verdict?.verdict, "disagree");
  assert.ok(verdict?.note?.includes("分歧"));
});

test("resolveConsensus：边界——中位恰为阈值 → pass；spread 恰为上限 → 不判分歧", () => {
  assert.equal(resolveConsensus([{ judgeId: "a", score: 0.7 }])?.verdict, "pass");
  const votes: JudgeVote[] = [
    { judgeId: "a", score: 0.8 },
    { judgeId: "b", score: 0.55 },
  ];
  const verdict = resolveConsensus(votes, { spreadLimit: 0.25 });
  // spread = 0.25 不超限 → 中位 0.675 < 0.7 → needs_revision
  assert.equal(verdict?.verdict, "needs_revision");
});

// ---------------------------------------------------------------------------
// Verdict Envelope
// ---------------------------------------------------------------------------

const INPUT_LAYERS: VerdictLayer[] = [
  {
    layer: "mechanical",
    label: "规则门",
    verdict: "pass",
    detail: "d",
    participants: ["patent_novelty"],
    at: "2026-01-01T00:00:00Z",
  },
  {
    layer: "semantic",
    label: "Judge",
    verdict: "0.8",
    detail: "d",
    participants: ["judge:a"],
    at: "2026-01-01T00:00:00Z",
  },
  { layer: "consensus", label: "共识", verdict: "pass", detail: "d", participants: [], at: "2026-01-01T00:00:00Z" },
];

test("buildVerdictEnvelope：层顺序强制 mechanical→semantic→consensus，hash 稳定", () => {
  const env = buildVerdictEnvelope({
    artifact: "报告摘要",
    artifactType: "graph:inventiveness/conclusion",
    layers: INPUT_LAYERS,
    now: () => "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(
    env.layers.map(l => l.layer),
    ["mechanical", "semantic", "consensus"],
  );
  assert.equal(env.overall, "pass");
  const again = buildVerdictEnvelope({
    artifact: "报告摘要",
    artifactType: "graph:inventiveness/conclusion",
    layers: INPUT_LAYERS,
    now: () => "2026-01-01T00:00:00Z",
  });
  assert.equal(env.hash, again.hash, "同输入同 hash（确定性）");
  assert.equal(verifyVerdictEnvelope(env), true);
});

test("buildVerdictEnvelope：乱序输入仍按三层固定序（销毁后 verifies）", () => {
  const shuffled: VerdictLayer[] = [INPUT_LAYERS[2]!, INPUT_LAYERS[0]!, INPUT_LAYERS[1]!];
  const env = buildVerdictEnvelope({
    artifact: "a",
    artifactType: "t",
    layers: shuffled,
    now: () => "2026-01-01T00:00:00Z",
  });
  assert.deepEqual(
    env.layers.map(l => l.layer),
    ["mechanical", "semantic", "consensus"],
  );
  assert.equal(verifyVerdictEnvelope(env), true);
});

test("verifyVerdictEnvelope：内容或特征篡改 → 失配 false（防镜像化）", () => {
  const env = buildVerdictEnvelope({
    artifact: "a",
    artifactType: "t",
    layers: INPUT_LAYERS,
    now: () => "2026-01-01T00:00:00Z",
  });
  assert.equal(verifyVerdictEnvelope(env), true);
  const tampered = { ...env, hash: "0".repeat(64) };
  assert.equal(verifyVerdictEnvelope(tampered), false);
  const contentTamper = {
    ...env,
    layers: [{ ...INPUT_LAYERS[0]!, verdict: "blocked" }, INPUT_LAYERS[1]!, INPUT_LAYERS[2]!],
  };
  assert.equal(verifyVerdictEnvelope(contentTamper), false);
  // 仅篡改 overall 判级（不动 layers/哈希）：重推导合成值仍为 "pass"，却与伪造值不符 → 失配。
  const overallTamper = { ...env, overall: "disagree" };
  assert.equal(verifyVerdictEnvelope(overallTamper), false);
});

test("compositeOverall：保守序 blocked > disagree > needs_revision > pass", () => {
  const layer = (l: VerdictLayer["layer"], verdict: string): VerdictLayer => ({
    layer: l,
    label: "x",
    verdict,
    detail: "",
    participants: [],
    at: "2026-01-01T00:00:00Z",
  });
  assert.equal(compositeOverall([layer("mechanical", "blocked"), layer("consensus", "pass")]), "blocked");
  assert.equal(compositeOverall([layer("mechanical", "pass"), layer("consensus", "disagree")]), "disagree");
  assert.equal(compositeOverall([layer("mechanical", "needs_revision"), layer("consensus", "pass")]), "needs_revision");
  assert.equal(compositeOverall([layer("mechanical", "pass"), layer("consensus", "pass")]), "pass");
  assert.equal(compositeOverall([layer("mechanical", "unknown")]), "unknown");
});

// ---------------------------------------------------------------------------
// collectJudgeVotes（多 judge 投票）
// ---------------------------------------------------------------------------

test("collectJudgeVotes：多 judge 并行投票（各一票），失败 judge fail-open 跳过", async () => {
  const votes = await collectJudgeVotes(
    [
      {
        judgeId: "judge:a",
        model: "model-a",
        callLLM: async () => JSON.stringify({ score: 0.85, rationale: "结论正确" }),
      },
      {
        judgeId: "judge:b",
        model: "model-b",
        callLLM: async () => {
          throw new Error("provider down");
        },
      },
      { judgeId: "judge:c", callLLM: async () => "0.6" },
    ],
    "题目",
    "产出",
    undefined,
  );
  assert.equal(votes.length, 2, "失败 judge 应跳过");
  assert.deepEqual(
    votes.map(v => v.judgeId),
    ["judge:a", "judge:c"],
  );
  assert.equal(votes[0]!.model, "model-a");
});

test("collectJudgeVotes：samples=3 每 judge 取中位；全部失败 → 空数组", async () => {
  const votes = await collectJudgeVotes(
    [{ judgeId: "judge:a", callLLM: async () => JSON.stringify({ score: 0.7, rationale: "r" }) }],
    "q",
    "a",
    undefined,
    { samples: 3 },
  );
  assert.equal(votes.length, 1);
  const none = await collectJudgeVotes(
    [
      {
        judgeId: "judge:a",
        callLLM: async () => {
          throw new Error("x");
        },
      },
    ],
    "q",
    "a",
    undefined,
  );
  assert.deepEqual(none, []);
});
