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
  const { readFile, access } = await import("node:fs/promises");
  const dir = mkdtempSync(join(tmpdir(), "sati-task-spill-"));
  tempDirs.push(dir);
  const store = new TaskOutputStore({ taskId: "task-x", diskSpillDir: dir });
  store.append("first chunk");
  store.append("second chunk");
  // Spill is flushed asynchronously; poll until the file appears instead of
  // relying on a fixed delay (slow CI filesystems can exceed 50 ms).
  const spillFile = join(dir, "task-x.log");
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      await access(spillFile);
      break;
    } catch {
      if (Date.now() > deadline) {
        throw new Error(`spill file was not created within 5s: ${spillFile}`);
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const onDisk = await readFile(spillFile, "utf8");
  assert.equal(onDisk, "first chunksecond chunk");
});

test("readSlice caps at a UTF-8 codepoint boundary instead of emitting U+FFFD", () => {
  const store = new TaskOutputStore({ taskId: "t-utf8-1" });
  store.append("你好世界"); // 每个汉字 3 字节，共 12 字节

  // maxBytes=4 落在"好"的中间：不产出 U+FFFD，尾部半个字符留给下一轮。
  const first = store.readSlice(0, 4);
  assert.equal(first.content, "你");
  assert.equal(first.nextOffset, 3);
  assert.ok(!first.content.includes("\uFFFD"));

  // 从回退后的 offset 继续，能完整解出剩余内容且无丢失。
  const second = store.readSlice(first.nextOffset);
  assert.equal(second.content, "好世界");
  assert.equal(second.nextOffset, 12);
  assert.equal(`${first.content}${second.content}`, "你好世界");
});

test("readSlice from a mid-codepoint offset skips the orphan continuation bytes", () => {
  const store = new TaskOutputStore({ taskId: "t-utf8-2" });
  store.append("你好"); // 6 字节

  // offset=1 从"你"的第二个字节开始：跳过孤立 continuation 字节，从"好"起可解码。
  const slice = store.readSlice(1);
  assert.ok(!slice.content.includes("\uFFFD"));
  assert.equal(slice.content, "好");
});

test("readSlice keeps ASCII slicing semantics unchanged", () => {
  const store = new TaskOutputStore({ taskId: "t-utf8-3" });
  store.append("hello world");
  const slice = store.readSlice(0, 5);
  assert.equal(slice.content, "hello");
  assert.equal(slice.nextOffset, 5);
  assert.equal(store.readSlice(5).content, " world");
});

test("readSlice re-serves a char split across stream chunks once complete", () => {
  const store = new TaskOutputStore({ taskId: "t-utf8-4" });
  // 模拟 stdout 分块把"好"劈开（子进程数据事件可任意切字节）。
  const full = Buffer.from("你好", "utf8");
  store.append(full.subarray(0, 4));

  // 先轮询：此时"好"只有前 2 字节在缓冲，序列不完整 → 本轮只解出"你"，
  // 不产 U+FFFD，nextOffset 回退到"好"的起点。
  const first = store.readSlice(0);
  assert.equal(first.content, "你");
  assert.equal(first.nextOffset, 3);

  // 写入方补齐"好"后再追加"世界"，从回退点重读即完整解出，无丢失。
  store.append(full.subarray(4));
  store.append("世界");
  const second = store.readSlice(first.nextOffset);
  assert.equal(second.content, "好世界");
  assert.equal(`${first.content}${second.content}`, "你好世界");
});
