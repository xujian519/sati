import test from "node:test";
import assert from "node:assert/strict";
import { TaskOutputStore } from "../../src/task/index.js";

test("C5.OUT.1 append + readSlice round-trips text", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("hello ");
  store.append("world");
  const slice = store.readSlice(0);
  assert.equal(slice.content, "hello world");
  assert.equal(slice.nextOffset, 11);
  assert.equal(slice.totalBytes, 11);
  assert.equal(slice.truncated, false);
});

test("C5.OUT.2 readSlice returns only the new bytes after the prior offset", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("part1 ");
  const a = store.readSlice(0);
  store.append("part2");
  const b = store.readSlice(a.nextOffset);
  assert.equal(a.content, "part1 ");
  assert.equal(b.content, "part2");
});

test("C5.OUT.3 ring buffer drops oldest bytes when over maxMemoryBytes", () => {
  const store = new TaskOutputStore({ taskId: "t1", maxMemoryBytes: 16 });
  store.append("aaaaaaaa"); // 8 bytes
  store.append("bbbbbbbb"); // 8 bytes — total 16, still fits
  store.append("cccccccc"); // overflow → drops "aaaaaaaa"
  const slice = store.readSlice(0);
  assert.equal(slice.truncated, true);
  assert.match(slice.content, /^bbbbbbbbcccccccc$/);
  assert.equal(slice.totalBytes, 24);
});

test("C5.OUT.4 maxBytes caps the returned slice without consuming the rest", () => {
  const store = new TaskOutputStore({ taskId: "t1" });
  store.append("123456789");
  const a = store.readSlice(0, 3);
  assert.equal(a.content, "123");
  assert.equal(a.nextOffset, 3);
  const b = store.readSlice(a.nextOffset);
  assert.equal(b.content, "456789");
});

test("C5.OUT.5 totalBytes() is monotonic across drops", () => {
  const store = new TaskOutputStore({ taskId: "t1", maxMemoryBytes: 4 });
  store.append("12");
  assert.equal(store.totalBytes(), 2);
  store.append("3456");
  assert.equal(store.totalBytes(), 6);
});
