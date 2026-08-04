import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createFlexiblePlan } from "../../src/patent/flexible-plan.js";
import { JsonFileFlexiblePlanStore } from "../../src/patent/flexible-plan-store.js";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sati-flexible-plan-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("JsonFileFlexiblePlanStore save/load 往返保持状态", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    const plan = createFlexiblePlan("case-1", "invalidation", {
      technicalField: "机械",
      stages: [
        {
          id: "s1",
          name: "分析",
          goal: "分析目标专利",
          strategy: "chain",
          status: "pending",
          artifacts: [],
          constraintIds: [],
          articleJudgments: [],
        },
        {
          id: "s2",
          name: "检索",
          goal: "检索对比文件",
          strategy: "chain",
          status: "pending",
          artifacts: [],
          constraintIds: [],
          articleJudgments: [],
        },
      ],
    });
    await store.savePlan(plan);
    const loaded = await store.loadPlan("case-1");
    assert.deepEqual(loaded, plan);
  });
});

test("loadPlan 不存在返回 undefined", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    const loaded = await store.loadPlan("no-such-case");
    assert.equal(loaded, undefined);
  });
});

test("listCaseIds 列出全部案例", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    await store.savePlan(createFlexiblePlan("case-a", "invalidation"));
    await store.savePlan(createFlexiblePlan("case-b", "infringement"));
    const ids = await store.listCaseIds();
    assert.deepEqual(ids.sort(), ["case-a", "case-b"]);
  });
});

test("非法 caseId（路径注入）抛 RangeError", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    await assert.rejects(() => store.savePlan(createFlexiblePlan("../evil", "invalidation")), RangeError);
    await assert.rejects(() => store.loadPlan("../evil"), RangeError);
    await assert.rejects(() => store.loadPlan(".hidden"), RangeError);
  });
});

test("保存的文件为合法 JSON 且含完整状态", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    const plan = createFlexiblePlan("case-x", "drafting", {
      stages: [
        {
          id: "s1",
          name: "撰写",
          goal: "撰写权利要求",
          strategy: "chain",
          status: "pending",
          artifacts: [],
          constraintIds: [],
          articleJudgments: [],
        },
      ],
    });
    await store.savePlan(plan);
    const raw = await readFile(join(dir, "case-x.json"), "utf8");
    const parsed = JSON.parse(raw) as { caseId: string; caseType: string; stages: unknown[] };
    assert.equal(parsed.caseId, "case-x");
    assert.equal(parsed.caseType, "drafting");
    assert.equal(parsed.stages.length, 1);
  });
});

test("多次 save 覆盖同一案例（幂等）", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    await store.savePlan(createFlexiblePlan("case-1", "invalidation"));
    await store.savePlan(createFlexiblePlan("case-1", "infringement"));
    const loaded = await store.loadPlan("case-1");
    assert.equal(loaded?.caseType, "infringement");
  });
});
