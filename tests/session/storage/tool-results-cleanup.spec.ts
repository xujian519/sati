import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupOrphanToolResults, DEFAULT_ORPHAN_GRACE_MS, toolResultsDirFor } from "../../../src/session/index.js";
import { getPilotProjectChatDir } from "../../../src/pilot/index.js";

const NOW = new Date("2026-07-09T00:00:00.000Z");
const OLD = new Date(NOW.getTime() - 2 * DEFAULT_ORPHAN_GRACE_MS);

async function setupFixture(): Promise<{
  projectRoot: string;
  pilotHome: string;
  chatDir: string;
  resultsRoot: string;
}> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-cleanup-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-home-"));
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  const resultsRoot = join(projectRoot, ".sati", "tool-results");
  await mkdir(resultsRoot, { recursive: true });
  await mkdir(chatDir, { recursive: true });
  return { projectRoot, pilotHome, chatDir, resultsRoot };
}

test("cleanup removes transcript-less stale dirs, keeps referenced and fresh ones", async () => {
  const { projectRoot, pilotHome, chatDir, resultsRoot } = await setupFixture();
  try {
    // a: 有 transcript → 保留（resume 依赖）
    await mkdir(join(resultsRoot, "a"));
    await writeFile(join(chatDir, "a.jsonl"), "");
    // b: 无 transcript，但 mtime 新 → 宽限期内保留（崩溃窗口）
    await mkdir(join(resultsRoot, "b"));
    // c: 无 transcript 且 mtime 老 → 回收
    await mkdir(join(resultsRoot, "c"));
    await writeFile(join(resultsRoot, "c", "body.txt"), "x".repeat(1000));
    await utimes(join(resultsRoot, "c"), OLD, OLD);

    const result = await cleanupOrphanToolResults({
      projectRoot,
      pilotHome,
      now: () => NOW,
      orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
    });

    assert.deepEqual(result.removedIds, ["c"]);
    assert.equal(result.removed, 1);
    assert.equal(result.retained, 2);
    assert.deepEqual((await readdir(resultsRoot)).sort(), ["a", "b"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("dryRun reports orphans without deleting", async () => {
  const { projectRoot, pilotHome, resultsRoot } = await setupFixture();
  try {
    const dir = join(resultsRoot, "orphan");
    await mkdir(dir);
    await utimes(dir, OLD, OLD);

    const result = await cleanupOrphanToolResults({
      projectRoot,
      pilotHome,
      now: () => NOW,
      orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
      dryRun: true,
    });

    assert.deepEqual(result.removedIds, ["orphan"]);
    assert.equal(result.removed, 1);
    assert.deepEqual(await readdir(resultsRoot), ["orphan"], "dry-run must not delete");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("missing tool-results root is a no-op", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-cleanup-empty-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-home-"));
  try {
    const result = await cleanupOrphanToolResults({ projectRoot, pilotHome, now: () => NOW });
    assert.deepEqual(result, { removed: 0, retained: 0, removedIds: [] });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("shared refs alias dir is never reclaimed even when stale", async () => {
  const { projectRoot, pilotHome, resultsRoot } = await setupFixture();
  try {
    // refs/ 跨会话共享（read_file 取回通道），不属于任何会话——即使 mtime
    // 远超宽限期也必须保留，否则全部会话的取回文件被一次性删除。
    const refsDir = join(resultsRoot, "refs");
    await mkdir(refsDir);
    await writeFile(join(refsDir, "result-0001.txt"), "shared alias body");
    await utimes(refsDir, OLD, OLD);
    // 对照：一个超期孤儿应被删除。
    const orphan = join(resultsRoot, "orphan");
    await mkdir(orphan);
    await utimes(orphan, OLD, OLD);

    const result = await cleanupOrphanToolResults({
      projectRoot,
      pilotHome,
      now: () => NOW,
      orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
    });

    assert.deepEqual(result.removedIds, ["orphan"]);
    assert.equal(result.removed, 1);
    assert.deepEqual((await readdir(resultsRoot)).sort(), ["refs"], "orphan removed, refs retained");
    assert.equal(await readFile(join(refsDir, "result-0001.txt"), "utf8"), "shared alias body");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("transcript white-list read failure fails closed (keeps everything)", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-cleanup-failclosed-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-home-"));
  try {
    // chatDir（{pilotHome}/projects/.../chats）缺失 → readdir 失败；
    // 此时不得把超期目录当孤儿批量删除（fail-open 会误删可恢复会话的
    // spill 原文），而应保留全部。
    const resultsRoot = join(projectRoot, ".sati", "tool-results");
    await mkdir(resultsRoot, { recursive: true });
    const stale = join(resultsRoot, "stale-session");
    await mkdir(stale);
    await writeFile(join(stale, "body.txt"), "x");
    await utimes(stale, OLD, OLD);

    const result = await cleanupOrphanToolResults({
      projectRoot,
      pilotHome,
      now: () => NOW,
      orphanGraceMs: DEFAULT_ORPHAN_GRACE_MS,
    });

    assert.deepEqual(result, { removed: 0, retained: 1, removedIds: [] });
    assert.deepEqual(await readdir(resultsRoot), ["stale-session"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("toolResultsDirFor sanitizes session ids like transcripts", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-cleanup-path-"));
  try {
    const dir = toolResultsDirFor(projectRoot, "always-on/discovery:project=/a/b:run=r1");
    assert.match(dir, /tool-results[\/\\]always-on-discovery:project=-a-b:run=r1$/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
