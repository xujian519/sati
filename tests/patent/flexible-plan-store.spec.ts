import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FlexiblePlanError, createFlexiblePlan } from "../../src/patent/flexible-plan.js";
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

test("非法 caseId（路径注入）被创建层拒绝（fail-closed 前移）", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    // createFlexiblePlan 现在提前拒绝，存储层不再收到非法 caseId
    assert.throws(() => createFlexiblePlan("../evil", "invalidation"), FlexiblePlanError);
    // loadPlan 仍防御非法 id（读取侧 RangeError）
    await assert.rejects(() => store.loadPlan("../evil"), RangeError);
    await assert.rejects(() => store.loadPlan(".hidden"), RangeError);
  });
});

test("listCaseIds 过滤目录中的外来文件", async () => {
  await withTempDir(async dir => {
    const store = new JsonFileFlexiblePlanStore(dir);
    await store.savePlan(createFlexiblePlan("case-a", "invalidation"));
    // 外来文件（不匹配安全字符集的 id）不应进入列表——否则 list→load 往返 RangeError
    await writeFile(join(dir, "draft 2.json"), "{}", "utf8");
    await writeFile(join(dir, ".hidden.json"), "{}", "utf8");
    const ids = await store.listCaseIds();
    assert.deepEqual(ids, ["case-a"]);
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
