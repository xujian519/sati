import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonFileStore, SAFE_ID_PATTERN, assertSafeId, atomicWriteJson } from "../../src/patent/persist-utils.js";

/** 此前的持久化辅助模块无直接测试，本文件补齐往返/损坏/注入/过滤覆盖。 */

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "persist-utils-test-"));
}

test("assertSafeId: 拒绝路径注入与隐藏文件，允许安全字符集", () => {
  assert.ok(SAFE_ID_PATTERN.test("case-123_a.b"));
  for (const bad of ["../etc", "a/b", "a\\b", ".hidden", "", "a b", "a:b"]) {
    assert.throws(() => assertSafeId(bad, "id"), RangeError, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => assertSafeId("case-123", "id"));
});

test("JsonFileStore: save → load → listIds 往返（原子写幂等覆盖）", async () => {
  const dir = tempDir();
  try {
    const store = new JsonFileStore<{ n: number }>(dir, raw => JSON.parse(raw) as { n: number });
    await store.save("run-1", { n: 1 });
    await store.save("run-2", { n: 2 });
    // 覆盖同一 id（原子写，不产生半写文件）
    await store.save("run-1", { n: 100 });
    assert.deepEqual(await store.load("run-1"), { n: 100 });
    assert.deepEqual(await store.load("run-2"), { n: 2 });
    assert.deepEqual((await store.listIds()).sort(), ["run-1", "run-2"]);
    // 目录中无残留临时文件
    const files = readdirSync(dir);
    assert.ok(!files.some(f => f.includes(".tmp-")), `不应残留临时文件: ${files.join(",")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore: load 缺失返回 undefined；损坏 JSON 抛错而非吞掉", async () => {
  const dir = tempDir();
  try {
    const store = new JsonFileStore<{ n: number }>(dir, raw => JSON.parse(raw) as { n: number });
    assert.equal(await store.load("missing"), undefined);
    // 写一个损坏 JSON（绕过 save）
    writeFileSync(join(dir, "broken.json"), "{not json");
    await assert.rejects(() => store.load("broken"), SyntaxError, "损坏 JSON 应抛解析错误（可观测）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore: listIds 过滤目录外来文件（安全字符集之外）", async () => {
  const dir = tempDir();
  try {
    const store = new JsonFileStore<{ n: number }>(dir, raw => JSON.parse(raw) as { n: number });
    await store.save("ok", { n: 1 });
    // 外来文件：非 .json / 非法 id / 隐藏文件
    writeFileSync(join(dir, "notes.txt"), "x");
    writeFileSync(join(dir, "..json"), "{}");
    writeFileSync(join(dir, ".hidden.json"), "{}");
    writeFileSync(join(dir, "with space.json"), "{}");
    assert.deepEqual(await store.listIds(), ["ok"], "应只返回安全字符集的 .json 文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("JsonFileStore: save 自动建目录（嵌套）", async () => {
  const dir = tempDir();
  try {
    const nested = join(dir, "a", "b");
    const store = new JsonFileStore<{ n: number }>(nested, raw => JSON.parse(raw) as { n: number });
    await store.save("run", { n: 1 });
    assert.deepEqual(await store.load("run"), { n: 1 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteJson: 内容完整写入（无 BOM/截断）", async () => {
  const dir = tempDir();
  try {
    const file = join(dir, "out.json");
    const content = JSON.stringify({ a: [1, 2, 3], b: "中文内容" });
    await atomicWriteJson(file, content);
    assert.equal(readFileSync(file, "utf8"), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
