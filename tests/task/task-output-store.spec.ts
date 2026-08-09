import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskOutputStore } from "../../src/task/index.js";

const tempDirs: string[] = [];

test.afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

test("append accepts string and buffer and totalBytes is monotonic", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  assert.equal(store.totalBytes(), 0);
  store.append("hello ");
  store.append(Buffer.from("world"));
  assert.equal(store.totalBytes(), 11);
  store.append("!");
  assert.equal(store.totalBytes(), 12);
});

test("append ignores empty chunks", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("");
  store.append(Buffer.alloc(0));
  assert.equal(store.totalBytes(), 0);
});

test("readSlice returns full content from offset 0", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("hello world");
  const slice = store.readSlice(0);
  assert.equal(slice.content, "hello world");
  assert.equal(slice.nextOffset, 11);
  assert.equal(slice.totalBytes, 11);
  assert.equal(slice.truncated, false);
});

test("readSlice bounds by maxBytes and advances nextOffset", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("hello world");
  const first = store.readSlice(0, 5);
  assert.equal(first.content, "hello");
  assert.equal(first.nextOffset, 5);
  const second = store.readSlice(first.nextOffset, 5);
  assert.equal(second.content, " worl");
  assert.equal(second.nextOffset, 10);
  const third = store.readSlice(second.nextOffset);
  assert.equal(third.content, "d");
  assert.equal(third.nextOffset, 11);
});

test("readSlice past head returns empty content", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("abc");
  const slice = store.readSlice(5);
  assert.equal(slice.content, "");
  assert.equal(slice.nextOffset, 3);
  assert.equal(slice.truncated, false);
});

test("ring buffer drops oldest bytes on overflow and marks truncated", () => {
  const store = new TaskOutputStore({ taskId: "t1", maxMemoryBytes: 10 });
  store.append("abcdef"); // 6 bytes
  store.append("ghij"); // 4 bytes -> exactly 10
  store.append("kl"); // 2 bytes -> overflow, drops "abcdef"
  assert.equal(store.totalBytes(), 12);
  const slice = store.readSlice(0);
  assert.equal(slice.truncated, true);
  assert.equal(slice.content, "ghijkl");
  assert.equal(slice.nextOffset, 12);
});

test("readSlice after truncation reflects dropped prefix only once", () => {
  const store = new TaskOutputStore({ taskId: "t1", maxMemoryBytes: 10 });
  store.append("abc"); // 3
  store.append("def"); // 6
  store.append("ghi"); // 9
  store.append("jkl"); // 12 -> drops "abc" (3 bytes)
  store.append("mno"); // 12 -> drops "def" (3 more bytes)
  assert.equal(store.totalBytes(), 15);
  const full = store.readSlice(0);
  assert.equal(full.truncated, true);
  assert.equal(full.content, "ghijklmno");
  // Reading from the surviving boundary (6) is not truncated.
  const fromBoundary = store.readSlice(6);
  assert.equal(fromBoundary.truncated, false);
  assert.equal(fromBoundary.content, "ghijklmno");
  assert.equal(fromBoundary.nextOffset, 15);
});

test("close clears memory but keeps totalBytes", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("some output");
  store.close();
  assert.equal(store.totalBytes(), 11);
  const slice = store.readSlice(0);
  assert.equal(slice.content, "");
  assert.equal(slice.nextOffset, 0);
});

test("disk spill appends overflow chunks to <dir>/<taskId>.log", async () => {
  const { readFile } = await import("node:fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "sati-task-spill-"));
  tempDirs.push(dir);
  const store = new TaskOutputStore({ taskId: "task-x", diskSpillDir: dir });
  store.append("first chunk");
  store.append("second chunk");
  // Spill is queued asynchronously; wait for the microtask drain.
  await new Promise(resolve => setTimeout(resolve, 50));
  const onDisk = await readFile(join(dir, "task-x.log"), "utf8");
  assert.equal(onDisk, "first chunksecond chunk");
});
