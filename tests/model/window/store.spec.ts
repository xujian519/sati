/**
 * `ModelWindowStore`：覆盖层的容错读取、冲突取小、来源归属与原子写。
 *
 * "取小 + 来源跟随被采纳值"是本层的核心语义：把 probe 的声明值冒充 observed
 * 会让设置页对用户说谎，而取大方向的错误会让压缩线推后到真实超限点。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  mergeModelWindowEntry,
  ModelWindowStore,
  modelWindowKey,
  parseModelWindowFile,
} from "../../../src/model/window/store.js";

const NOW = "2026-09-19T00:00:00.000Z";

async function withStore(run: (store: ModelWindowStore, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "sati-model-window-"));
  try {
    await run(new ModelWindowStore(join(dir, "model-windows.json")), dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("文件缺失 → 空表，单条读取返回 undefined", async () => {
  await withStore(async store => {
    assert.deepEqual(store.read().entries, {});
    assert.equal(store.read().entries[modelWindowKey("deepseek", "deepseek-v4-flash")], undefined);
  });
});

test("record 落盘后可同步读回", async () => {
  await withStore(async store => {
    await store.record("deepseek", "deepseek-v4-flash", {
      maxContextTokens: 131072,
      maxOutputTokens: 8192,
      source: "probe",
      updatedAt: NOW,
      via: "context_length",
    });
    const entry = store.read().entries[modelWindowKey("deepseek", "deepseek-v4-flash")];
    assert.equal(entry?.maxContextTokens, 131072);
    assert.equal(entry?.source, "probe");
    assert.equal(entry?.via, "context_length");
  });
});

test("observed 比 probe 小 → 采纳 observed 并标注 observed", () => {
  const merged = mergeModelWindowEntry(
    { maxContextTokens: 200000, source: "probe", updatedAt: NOW },
    { maxContextTokens: 131072, source: "observed", updatedAt: NOW, via: "provider-context-cap" },
  );
  assert.equal(merged.maxContextTokens, 131072);
  assert.equal(merged.source, "observed");
  assert.equal(merged.via, "provider-context-cap");
});

test("probe 比 observed 小 → 采纳 probe 且来源跟随 probe（不冒充 observed）", () => {
  const merged = mergeModelWindowEntry(
    { maxContextTokens: 200000, source: "observed", updatedAt: NOW },
    { maxContextTokens: 131072, source: "probe", updatedAt: NOW, via: "context_length" },
  );
  assert.equal(merged.maxContextTokens, 131072);
  assert.equal(merged.source, "probe");
});

test("单侧缺失的维度不互相覆盖（只有输出上限也照样记下来）", () => {
  const merged = mergeModelWindowEntry(
    { maxContextTokens: 131072, source: "probe", updatedAt: NOW },
    { maxOutputTokens: 4096, source: "observed", updatedAt: NOW },
  );
  assert.equal(merged.maxContextTokens, 131072);
  assert.equal(merged.maxOutputTokens, 4096);
  // 上下文窗口那一维来自 probe，故 source = probe。
  assert.equal(merged.source, "probe");
});

test("损坏 JSON / 未知版本 / 非法条目 → 空表或丢弃该条", () => {
  assert.deepEqual(parseModelWindowFile("{ not json").entries, {});
  assert.deepEqual(parseModelWindowFile(JSON.stringify({ version: 99, entries: { a: {} } })).entries, {});
  const parsed = parseModelWindowFile(
    JSON.stringify({
      version: 1,
      entries: {
        "p/m": { maxContextTokens: 131072, source: "probe", updatedAt: NOW },
        "p/bad-source": { maxContextTokens: 131072, source: "guess", updatedAt: NOW },
        "p/out-of-range": { maxContextTokens: 7, source: "probe", updatedAt: NOW },
        "p/empty": { source: "probe", updatedAt: NOW },
      },
    }),
  );
  assert.deepEqual(Object.keys(parsed.entries), ["p/m"]);
});

test("record 合并写入：第二次写不覆盖已有维度（原子写产出合法 JSON）", async () => {
  await withStore(async (store, dir) => {
    await store.record("openrouter", "vendor/model", {
      maxContextTokens: 200000,
      source: "probe",
      updatedAt: NOW,
    });
    await store.record("openrouter", "vendor/model", {
      maxContextTokens: 131072,
      source: "observed",
      updatedAt: NOW,
      via: "provider-context-cap",
    });
    const raw = await readFile(join(dir, "model-windows.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      version: number;
      entries: Record<string, { maxContextTokens: number; source: string }>;
    };
    assert.equal(parsed.version, 1);
    assert.equal(parsed.entries[modelWindowKey("openrouter", "vendor/model")]?.maxContextTokens, 131072);
    assert.equal(parsed.entries[modelWindowKey("openrouter", "vendor/model")]?.source, "observed");
  });
});

test("forget：清除存在项返回 true，重复清除返回 false", async () => {
  await withStore(async (store, dir) => {
    await store.record("p", "m", { maxContextTokens: 8192, source: "probe", updatedAt: NOW });
    assert.equal(await store.forget("p", "m"), true);
    assert.equal(await store.forget("p", "m"), false);
    const raw = await readFile(join(dir, "model-windows.json"), "utf8");
    assert.deepEqual(JSON.parse(raw), { version: 1, entries: {} });
  });
});

test("读取损坏文件不抛错（fail-open）", async () => {
  await withStore(async (store, dir) => {
    await writeFile(join(dir, "model-windows.json"), "{ broken", "utf8");
    assert.deepEqual(store.read().entries, {});
  });
});
