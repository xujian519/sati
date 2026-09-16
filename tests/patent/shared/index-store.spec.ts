/**
 * 通用索引存储工厂（`src/patent/shared/index-store.ts`）单元测试。
 *
 * 判据分三组：
 * 1. **注入点承重**——`label` / `keyOf` / `compare` / `isValidEntry` 各自被真正使用，
 *    而不是工厂内硬编码了某一种域的取值；
 * 2. **队列清退**——`pendingWrites()` 能反映真实队列（探针灵敏度），upsert 完成后队尾归零
 *    （`TD-PATENT-N24` 的队尾清退），且清退**只在自己仍是队尾时**发生（否则后继写入会与
 *    本次并发，破坏串行化）。
 * 3. **结构判据**——chemistry/figure 两个模块只剩域差异声明，实现只此一处（防回退）。
 *
 * 第 2 组是本轮唯一**有意**的行为变更，故用工厂自建最小域独立验证，不借道
 * chemistry/figure 的既有用例（那些用例锁的是等价性，必须保持全绿）。
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  createIndexStore,
  type IndexEntryBase,
  type IndexStore,
  type IndexStoreSpec,
} from "../../../src/patent/shared/index-store.js";

/** 测试用最小域：条目 = 来源键 + 时间（就够覆盖工厂的全部注入点）。 */
type MiniEntry = IndexEntryBase & {
  subjectKey: string;
};

function makeEntry(subjectKey: string): MiniEntry {
  return { subjectKey, analyzedAt: "2026-09-16T00:00:00.000Z" };
}

function miniStore(overrides: Partial<IndexStoreSpec<1, MiniEntry>> = {}): IndexStore<MiniEntry> {
  return createIndexStore<1, MiniEntry>({
    label: "测试索引",
    version: 1,
    keyOf: entry => entry.subjectKey,
    compare: (a, b) => a.subjectKey.localeCompare(b.subjectKey),
    isValidEntry: (value): value is MiniEntry => {
      const entry = value as Partial<MiniEntry> | null;
      return (
        typeof entry === "object" &&
        entry !== null &&
        typeof entry.subjectKey === "string" &&
        typeof entry.analyzedAt === "string"
      );
    },
    ...overrides,
  });
}

async function tmpIndexFile(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "sati-index-store-"));
  const file = path.join(dir, ".sati", "index.json");
  await mkdir(path.dirname(file), { recursive: true });
  return file;
}

async function cleanup(file: string): Promise<void> {
  await rm(path.dirname(path.dirname(file)), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 1. 注入点承重
// ---------------------------------------------------------------------------

test("label 决定三处 warning 文案（未被硬编码）", async () => {
  const file = await tmpIndexFile();
  try {
    const chem = miniStore({ label: "甲索引" });
    const fig = miniStore({ label: "乙索引" });

    await writeFile(file, "{ 这不是 JSON", "utf8");
    const corruptChem = await chem.load(file);
    const corruptFig = await fig.load(file);
    assert.equal(corruptChem.warning, "甲索引文件损坏，已按空索引处理");
    assert.equal(corruptFig.warning, "乙索引文件损坏，已按空索引处理");

    await writeFile(file, JSON.stringify({ version: 999, updatedAt: "x", entries: [] }), "utf8");
    assert.equal((await chem.load(file)).warning, "甲索引版本不兼容或结构异常，已按空索引处理");

    await writeFile(
      file,
      JSON.stringify({ version: 1, updatedAt: "x", entries: [makeEntry("ok"), { subjectKey: 1 }] }),
      "utf8",
    );
    assert.equal((await chem.load(file)).warning, "甲索引中存在 1 条无效条目，已忽略");
  } finally {
    await cleanup(file);
  }
});

test("keyOf 决定合并去重（同键覆盖、异键追加）", async () => {
  const file = await tmpIndexFile();
  try {
    const byKey = miniStore();
    await byKey.upsert(file, makeEntry("a"));
    await byKey.upsert(file, makeEntry("b"));
    await byKey.upsert(file, makeEntry("a"));
    assert.deepEqual(
      (await byKey.load(file)).entries.map(e => e.subjectKey),
      ["a", "b"],
    );

    // 换一个 keyOf（全条目同键）⇒ 合并语义随之改变，证明 keyOf 真被使用
    const constant = miniStore({ keyOf: () => "same" });
    const file2 = `${file}.2`;
    await constant.upsert(file2, makeEntry("a"));
    await constant.upsert(file2, makeEntry("b"));
    assert.deepEqual(
      (await constant.load(file2)).entries.map(e => e.subjectKey),
      ["b"],
    );
  } finally {
    await cleanup(file);
  }
});

test("compare 决定写回顺序（未被内建排序覆盖）", async () => {
  const file = await tmpIndexFile();
  try {
    const ascending = miniStore();
    await ascending.upsert(file, makeEntry("b"));
    await ascending.upsert(file, makeEntry("a"));
    await ascending.upsert(file, makeEntry("c"));
    assert.deepEqual(
      (await ascending.load(file)).entries.map(e => e.subjectKey),
      ["a", "b", "c"],
    );

    const descending = miniStore({ compare: (a, b) => b.subjectKey.localeCompare(a.subjectKey) });
    const file2 = `${file}.2`;
    await descending.upsert(file2, makeEntry("b"));
    await descending.upsert(file2, makeEntry("a"));
    await descending.upsert(file2, makeEntry("c"));
    assert.deepEqual(
      (await descending.load(file2)).entries.map(e => e.subjectKey),
      ["c", "b", "a"],
    );
  } finally {
    await cleanup(file);
  }
});

test("isValidEntry 决定条目过滤（注入的守卫即判据）", async () => {
  const file = await tmpIndexFile();
  try {
    const strict = miniStore({
      isValidEntry: (value): value is MiniEntry =>
        typeof value === "object" && value !== null && (value as MiniEntry).subjectKey.startsWith("ok-"),
    });
    // save 不做 shape 校验（与收敛前一致）：畸形条目只能由外部写入
    await strict.save(file, [makeEntry("ok-1"), makeEntry("bad-1"), makeEntry("bad-2")]);
    const loaded = await strict.load(file);
    assert.deepEqual(
      loaded.entries.map(e => e.subjectKey),
      ["ok-1"],
    );
    assert.equal(loaded.warning, "测试索引中存在 2 条无效条目，已忽略");
  } finally {
    await cleanup(file);
  }
});

// ---------------------------------------------------------------------------
// 2. 队列清退（TD-PATENT-N24）
// ---------------------------------------------------------------------------

test("pendingWrites 反映真实队列（探针灵敏度）", async () => {
  const file = await tmpIndexFile();
  try {
    const store = miniStore();
    // 同一文件路径：N 次并发写入共用一条队尾链 ⇒ 队列里仍是 1 项（键是文件路径）
    const keys = ["k1", "k2", "k3", "k4", "k5", "k6"];
    const sameFile = Promise.all(keys.map(key => store.upsert(file, makeEntry(key))));
    assert.equal(store.pendingWrites(), 1, "同一文件的并发写入共用一条队尾链");
    // 不同文件路径：排队项数随之增长（证明探针读的是队列本身，而不是常量）
    const others = ["a", "b", "c"].map(suffix => `${file}.${suffix}`);
    const othersPending = Promise.all(others.map(other => store.upsert(other, makeEntry("k"))));
    assert.equal(store.pendingWrites(), 1 + others.length, "另有 3 个文件在排队");
    await Promise.all([sameFile, othersPending]);
    assert.equal(store.pendingWrites(), 0, "全部完成后队尾应清空（恒 0 的探针在此前已被排除）");
    assert.equal((await store.load(file)).entries.length, keys.length);
  } finally {
    await cleanup(file);
  }
});

test("upsert 完成后队尾清退（长驻进程不无界增长）", async () => {
  const file = await tmpIndexFile();
  try {
    const store = miniStore();
    for (const key of ["k1", "k2", "k3"]) {
      await store.upsert(file, makeEntry(key));
      assert.equal(store.pendingWrites(), 0, `${key} 写入完成后队尾应清退`);
    }
    // 换文件路径继续写入：Map 也不应累积（键是文件路径，跨 case 场景的泄漏面）
    for (const suffix of ["a", "b", "c"]) {
      await store.upsert(`${file}.${suffix}`, makeEntry("k"));
    }
    assert.equal(store.pendingWrites(), 0, "跨文件路径写入后队尾仍应为空");
  } finally {
    await cleanup(file);
  }
});

test("损坏备份不堆积：索引在首次 upsert 后即被修复（TD-PATENT-N24 的备份半边的核证）", async () => {
  const file = await tmpIndexFile();
  try {
    const store = miniStore();
    await writeFile(file, "{ 这不是 JSON", "utf8");
    await store.upsert(file, makeEntry("k1"));
    await store.upsert(file, makeEntry("k2"));
    await store.upsert(file, makeEntry("k3"));
    const names = await readdir(path.dirname(file));
    const backups = names.filter(name => name.includes(".corrupt-"));
    assert.equal(backups.length, 1, "损坏索引在首次 upsert 即被重写为合法内容，后续 upsert 不再命中 warning");
    assert.equal((await store.load(file)).entries.length, 3);
  } finally {
    await cleanup(file);
  }
});

test("队尾清退仅在自己仍是队尾时发生（否则后继写入会与它并发）", async () => {
  const file = await tmpIndexFile();
  try {
    const store = miniStore();
    const p1 = store.upsert(file, makeEntry("k"));
    const p2 = store.upsert(file, makeEntry("k"));
    await p1;
    assert.equal(store.pendingWrites(), 1, "p2 仍在排队——队尾不得被 p1 提前清退");
    const p3 = store.upsert(file, makeEntry("k"));
    assert.equal(store.pendingWrites(), 1, "p3 接在 p2 之后，队尾仍是 1 项");
    await Promise.all([p2, p3]);
    assert.equal(store.pendingWrites(), 0);
    assert.equal((await store.load(file)).entries.length, 1, "同键并发写入仍须收敛为 1 条");
  } finally {
    await cleanup(file);
  }
});

// ---------------------------------------------------------------------------
// 3. 结构判据：实现只有一处
// ---------------------------------------------------------------------------

/**
 * 本文件在 tsx 直跑下位于 `tests/patent/shared/`、在 `pnpm test` 下位于
 * `dist/tests/patent/shared/`；两种布局下 `../../../src/...` 都指向各自的 src 树，
 * 只差扩展名（前者 `.ts`、后者 `.js`），故按「同名双候选 + 存在性择一」定位。
 */
function locateModuleSource(relativePath: string): string | undefined {
  const base = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [`${relativePath}.ts`, `${relativePath}.js`].map(rel => path.resolve(base, rel));
  return candidates.find(candidate => existsSync(candidate));
}

/**
 * 两个域模块不得再出现的实现细节（即「实现只此一处」）。
 *
 * 第三项只写到 `new Map`（不带 `<` 也不带 `(`）：`pnpm test` 读 `dist/` 里的**编译产物**，
 * TypeScript 泛型在编译时被擦除——`new Map<string, Promise<unknown>>()` 与 `new Map()` 互斥
 * （前者有 `<` 无 `(`、后者有 `(` 无 `<`），写任何一种形态都会在其中一种布局下**假红**
 * （首轮 `pnpm test` 实测）。判据只钉「这里不该出现 Map」，形态差异交给编译。
 */
const IMPLEMENTATION_DETAILS = ["copyFile(", "atomicWriteJson", "new Map"];
const DOMAIN_MODULES = [
  ["chemistry", "../../../src/patent/chemistry/index-store"],
  ["figure", "../../../src/patent/figure/index-store"],
] as const;

for (const [domain, relativePath] of DOMAIN_MODULES) {
  test(`结构判据：${domain} 索引模块只声明域差异，不再自带实现`, t => {
    const src = locateModuleSource(relativePath);
    if (src === undefined) {
      t.skip(`未定位到 ${relativePath}（两种布局都不匹配）——本判据本次未生效`);
      return;
    }
    const text = readFileSync(src, "utf8");
    assert.ok(text.includes("createIndexStore("), `${domain} 应通过工厂构造实例`);
    for (const detail of IMPLEMENTATION_DETAILS) {
      assert.equal(text.includes(detail), false, `${domain} 又出现了实现细节 ${detail}——实现被抄回副本，收敛退化`);
    }
  });
}

test("结构判据：共享工厂持有全部实现细节", t => {
  const src = locateModuleSource("../../../src/patent/shared/index-store");
  if (src === undefined) {
    t.skip("未定位到 shared/index-store——本判据本次未生效");
    return;
  }
  const text = readFileSync(src, "utf8");
  for (const detail of IMPLEMENTATION_DETAILS) {
    assert.ok(text.includes(detail), `共享工厂应持有 ${detail}`);
  }
});
