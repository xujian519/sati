import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AtomRegistry,
  InMemoryWorkflowRunStore,
  JsonFileWorkflowRunStore,
  StageHandlerRegistry,
  patentNoveltyManifest,
  runWorkflow,
  type WorkflowContext,
  type WorkflowRunStore,
  type WorkflowStage,
} from "../../src/patent/index.js";

function okExecutor(stage: WorkflowStage, ctx: WorkflowContext): Promise<string> {
  return Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);
}

/** 空 handler 注册表 + 仅含契约的 atom 注册表：强制 atom 阶段回退 executor 路径。 */
function emptyRegistries() {
  const handlers = new StageHandlerRegistry();
  const atoms = new AtomRegistry();
  for (const stage of patentNoveltyManifest.stages) {
    if (stage.atom) {
      atoms.register({ name: stage.atom, description: "test", category: "extract", inputSchema: [], outputSchema: [] });
    }
  }
  return { handlers, atoms };
}

test("runWorkflow with InMemoryWorkflowRunStore persists the result", async () => {
  const store = new InMemoryWorkflowRunStore();
  const result = await runWorkflow(patentNoveltyManifest, { input: "一种自动化分拣装置" }, okExecutor, {
    persist: store,
    ...emptyRegistries(),
  });
  const loaded = await store.loadRun("patent_novelty_v1");
  assert.ok(loaded);
  assert.deepEqual(loaded, result);
  assert.deepEqual(await store.listRuns(), ["patent_novelty_v1"]);
});

test("InMemoryWorkflowRunStore honors a custom runId", async () => {
  const store = new InMemoryWorkflowRunStore();
  await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store, runId: "case-001", ...emptyRegistries() });
  assert.equal((await store.loadRun("case-001"))?.manifestId, "patent_novelty_v1");
  assert.equal(await store.loadRun("patent_novelty_v1"), undefined, "缺省 manifestId 键不应被写入");
});

test("JsonFileWorkflowRunStore roundtrips through the filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-"));
  try {
    const store = new JsonFileWorkflowRunStore(dir);
    const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store, ...emptyRegistries() });
    const loaded = await store.loadRun("patent_novelty_v1");
    assert.ok(loaded);
    assert.deepEqual(loaded, result);
    assert.deepEqual(await store.listRuns(), ["patent_novelty_v1"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("JsonFileWorkflowRunStore returns undefined / empty list for missing runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-"));
  try {
    const store = new JsonFileWorkflowRunStore(dir);
    assert.equal(await store.loadRun("nope"), undefined);
    assert.deepEqual(await store.listRuns(), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow without persist does not write anything", async () => {
  const store = new InMemoryWorkflowRunStore();
  await runWorkflow(patentNoveltyManifest, {}, okExecutor, emptyRegistries());
  assert.deepEqual(await store.listRuns(), []);
});

test("JsonFileWorkflowRunStore rejects runIds with path separators or traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-"));
  try {
    const store = new JsonFileWorkflowRunStore(dir);
    const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, emptyRegistries());
    for (const bad of ["../evil", "a/b", "a\\b", ".hidden", "", ".."]) {
      await assert.rejects(() => store.saveRun(result, bad), RangeError, `runId ${JSON.stringify(bad)} 应被拒绝`);
      await assert.rejects(() => store.loadRun(bad), RangeError, `loadRun ${JSON.stringify(bad)} 应被拒绝`);
    }
    // 合法 runId 不受影响
    await store.saveRun(result, "case-001.run_v2");
    assert.ok(await store.loadRun("case-001.run_v2"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runWorkflow degrades gracefully when persist saveRun throws", async () => {
  const failingStore: WorkflowRunStore = {
    saveRun: async () => {
      throw new Error("disk full");
    },
    loadRun: async () => undefined,
    listRuns: async () => [],
  };
  const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, {
    persist: failingStore,
    ...emptyRegistries(),
  });
  assert.equal(result.completed, true);
  assert.match(result.persistWarning ?? "", /持久化失败/);
  assert.match(result.persistWarning ?? "", /disk full/);
});

test("JsonFileWorkflowRunStore 兼容旧 run JSON（无 revisions / degradations 字段）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-legacy-"));
  try {
    const legacy = {
      manifestId: "legacy_run",
      caseType: "test",
      completed: true,
      stages: [],
      degradedSteps: [],
      summary: "旧版本产物",
    };
    await writeFile(join(dir, "legacy_run.json"), JSON.stringify(legacy), "utf8");
    const loaded = await new JsonFileWorkflowRunStore(dir).loadRun("legacy_run");
    assert.equal(loaded?.manifestId, "legacy_run");
    assert.equal(loaded?.revisions, undefined);
    assert.equal(loaded?.degradations, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
