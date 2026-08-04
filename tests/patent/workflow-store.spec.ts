import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryWorkflowRunStore,
  JsonFileWorkflowRunStore,
  patentNoveltyManifest,
  runWorkflow,
  type WorkflowContext,
  type WorkflowRunStore,
  type WorkflowStage,
} from "../../src/patent/index.js";

function okExecutor(stage: WorkflowStage, ctx: WorkflowContext): Promise<string> {
  return Promise.resolve(`[${stage.id}] 完成。输入: ${ctx.input ?? ""}`);
}

test("runWorkflow with InMemoryWorkflowRunStore persists the result", async () => {
  const store = new InMemoryWorkflowRunStore();
  const result = await runWorkflow(patentNoveltyManifest, { input: "一种自动化分拣装置" }, okExecutor, {
    persist: store,
  });
  const loaded = await store.loadRun("patent_novelty_v1");
  assert.ok(loaded);
  assert.deepEqual(loaded, result);
  assert.deepEqual(await store.listRuns(), ["patent_novelty_v1"]);
});

test("InMemoryWorkflowRunStore honors a custom runId", async () => {
  const store = new InMemoryWorkflowRunStore();
  await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store, runId: "case-001" });
  assert.equal((await store.loadRun("case-001"))?.manifestId, "patent_novelty_v1");
  assert.equal(await store.loadRun("patent_novelty_v1"), undefined, "缺省 manifestId 键不应被写入");
});

test("JsonFileWorkflowRunStore roundtrips through the filesystem", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-"));
  try {
    const store = new JsonFileWorkflowRunStore(dir);
    const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: store });
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
  await runWorkflow(patentNoveltyManifest, {}, okExecutor);
  assert.deepEqual(await store.listRuns(), []);
});

test("JsonFileWorkflowRunStore rejects runIds with path separators or traversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-wf-"));
  try {
    const store = new JsonFileWorkflowRunStore(dir);
    const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor);
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
  const result = await runWorkflow(patentNoveltyManifest, {}, okExecutor, { persist: failingStore });
  assert.equal(result.completed, true);
  assert.match(result.persistWarning ?? "", /持久化失败/);
  assert.match(result.persistWarning ?? "", /disk full/);
});
