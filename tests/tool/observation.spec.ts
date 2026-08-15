/**
 * 文件观测三态语义测试（阶段四 T5）。
 *
 * 覆盖：classifyWriteIntent 全矩阵（create/overwrite/未观测拒绝/版本过期拒绝/
 * 全量读哈希复核兜底）、observedStateOf 三态映射。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SatiWriteSnapshotEntry } from "../../src/tool/protocol/types.js";
import { classifyWriteIntent, observedStateOf } from "../../src/tool/builtin/filesystem/observation.js";

function snapshot(overrides: Partial<SatiWriteSnapshotEntry> = {}): SatiWriteSnapshotEntry {
  return {
    absolutePath: "/p/a.md",
    mtimeMs: 1000,
    contentHash: "hash-1",
    ...overrides,
  };
}

test("classifyWriteIntent：文件不存在 → create（create-if-absent）", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: undefined,
    exists: false,
    mtimeMatches: false,
    hashMatches: false,
    fullRead: true,
  });
  assert.deepEqual(decision, { intent: "create" });
});

test("classifyWriteIntent：存在但未观测 → refuse file_not_observed", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: undefined,
    exists: true,
    mtimeMatches: false,
    hashMatches: false,
    fullRead: true,
  });
  assert.equal(decision.intent, "refuse");
  if (decision.intent === "refuse") {
    assert.equal(decision.code, "file_not_observed");
    assert.match(decision.message, /has not been read yet/i);
  }
});

test("classifyWriteIntent：观测且 mtime 匹配 → overwrite", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: snapshot(),
    exists: true,
    mtimeMatches: true,
    hashMatches: false,
    fullRead: true,
  });
  assert.deepEqual(decision, { intent: "overwrite" });
});

test("classifyWriteIntent：mtime 不匹配 + 全量读哈希匹配 → overwrite（复核兜底）", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: snapshot(),
    exists: true,
    mtimeMatches: false,
    hashMatches: true,
    fullRead: true,
  });
  assert.deepEqual(decision, { intent: "overwrite" });
});

test("classifyWriteIntent：mtime 不匹配且哈希不匹配 → refuse file_stale_version", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: snapshot(),
    exists: true,
    mtimeMatches: false,
    hashMatches: false,
    fullRead: true,
  });
  assert.equal(decision.intent, "refuse");
  if (decision.intent === "refuse") {
    assert.equal(decision.code, "file_stale_version");
    assert.match(decision.message, /has changed since the last read/i);
  }
});

test("classifyWriteIntent：部分读（非全量）且 mtime 不匹配 → refuse（不信任哈希）", () => {
  const decision = classifyWriteIntent({
    path: "/p/a.md",
    snapshot: snapshot({ offset: 0, limit: 100 }),
    exists: true,
    mtimeMatches: false,
    hashMatches: true,
    fullRead: false,
  });
  assert.equal(decision.intent, "refuse");
  if (decision.intent === "refuse") {
    assert.equal(decision.code, "file_stale_version");
  }
});

test("observedStateOf：快照存在 present、缺失 unseen", () => {
  assert.equal(observedStateOf(snapshot()), "present");
  assert.equal(observedStateOf(undefined), "unseen");
});
