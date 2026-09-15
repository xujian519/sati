import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { reconstructPnpmLinks } from "../../apps/desktop/src/runtime-layout.js";

/**
 * vstore 重链的两份实现**跨实现一致性**判据。
 *
 * 为什么需要它：同一件事有两份实现——运行时那份（`runtime-layout.ts`，用户机器上跑）
 * 与 Windows 验证那份（`scripts/relink-pnpm-win.mjs`，`verify-installer.bat` 调）。
 * 两份都由 `fs` 直接操作目录，**没有类型面把它们连起来**，改一份忘另一份不会红在任何
 * 编译或既有测试上——只会表现为「验证通过但用户装完跑不起来」。本用例把两份拉到同一棵
 * 合成树上跑，逐条比对产物链接映射。
 *
 * 刻意不等同的两点（mjs 侧 docstring 已列）由下面的用例显式钉住，而不是留成默契：
 *   - 覆盖范围：mjs 走**所有** node_modules，运行时版只从三个种子集合 BFS ⇒ 超集；
 *   - 借用 vstore：自身没有 `.pnpm` 的树（satiui）用兄弟树的 vstore 补。
 */

const specDir = path.dirname(fileURLToPath(import.meta.url));

/** 同时可从 dist/tests/desktop/ 与 tests/desktop/ 解析到仓库里的 mjs。 */
function relinkScriptPath(): string {
  const candidates = [
    path.join(specDir, "../../../apps/desktop/scripts/relink-pnpm-win.mjs"),
    path.join(specDir, "../../apps/desktop/scripts/relink-pnpm-win.mjs"),
  ];
  const hit = candidates.find(existsSync);
  assert.ok(hit, `找不到 relink-pnpm-win.mjs，候选：${candidates.join(", ")}`);
  return hit;
}

type RelinkModule = {
  relinkTrees: (treeDirs: string[], log?: (message: string) => void) => void;
};

let cached: Promise<RelinkModule> | undefined;
function relink(): Promise<RelinkModule> {
  cached ??= import(pathToFileURL(relinkScriptPath()).href) as Promise<RelinkModule>;
  return cached;
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sati-relink-parity-"));
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function putVstore(treeDir: string, name: string, version: string): void {
  const enc = name.startsWith("@") ? name.replace("/", "+") : name;
  const dir = path.join(treeDir, "node_modules", ".pnpm", `${enc}@${version}`, "node_modules", name);
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
}

/** 解包后被 bsdtar 物化成实目录的包（vstore junction 的残骸）。 */
function putRealPackage(nmDir: string, name: string, version: string): string {
  const dir = path.join(nmDir, name);
  mkdirp(dir);
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

/**
 * 造一棵贴近真实解包形态的树：sati-main 自带 vstore，satiui 没有。
 * `extra` 控制是否加入「workspace 包内部的 node_modules」这一 mjs 独有覆盖的形态。
 */
function buildTree(root: string, extra = false): { mainDir: string; uiDir: string } {
  const mainDir = path.join(root, "sati-main");
  const uiDir = path.join(root, "satiui");
  for (const [name, ver] of [
    ["foo", "1.0.0"],
    ["bar", "2.0.0"],
    ["@scope/baz", "3.1.4"],
    ["isolated-dep", "0.0.1"],
    // 唯一候选 + 版本对不上：专测「单候选回退」这条弱化分支
    ["qux", "0.0.1"],
  ] as const) {
    putVstore(mainDir, name, ver);
  }
  mkdirp(path.join(uiDir, "node_modules"));

  putRealPackage(path.join(mainDir, "node_modules"), "foo", "1.0.0");
  putRealPackage(path.join(mainDir, "node_modules"), "@scope/baz", "3.1.4");
  putRealPackage(path.join(mainDir, "node_modules"), "qux", "9.9.9");
  // vstore 内部：被物化的隔离传递依赖
  putRealPackage(path.join(mainDir, "node_modules", ".pnpm", "foo@1.0.0", "node_modules"), "isolated-dep", "0.0.1");
  // pnpm 公共 hoist 根：两版都应跳过（只重复 vstore，且不在去重 tar 里）
  putRealPackage(path.join(mainDir, "node_modules", ".pnpm", "node_modules"), "bar", "2.0.0");
  // satiui 自己的实包目录：自身没有 .pnpm，须借 sati-main 的 vstore 才能重链
  putRealPackage(path.join(uiDir, "node_modules"), "bar", "2.0.0");
  if (extra) {
    // workspace 包内部的 node_modules：只有 mjs 的「遍历全树」会走到
    putRealPackage(path.join(mainDir, "packages", "ws-a", "node_modules"), "foo", "1.0.0");
  }
  return { mainDir, uiDir };
}

/** 逐条收集整棵树里的符号链接 → 目标（相对 root），不进入符号链接。 */
function linkMap(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const realRoot = fs.realpathSync(root);
  const walk = (dir: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        out[relPath] = path.relative(realRoot, fs.realpathSync(abs));
        continue;
      }
      if (st.isDirectory()) walk(abs, relPath);
    }
  };
  walk(root, "");
  return out;
}

test("两份 vstore 重链实现对同一棵树产出一致的链接映射", async () => {
  const rootTs = tmpRoot();
  const tsTree = buildTree(path.join(rootTs, "t"));
  reconstructPnpmLinks(tsTree.mainDir, [tsTree.uiDir]);
  const fromTs = linkMap(rootTs);

  const rootMjs = tmpRoot();
  const mjsTree = buildTree(path.join(rootMjs, "t"));
  (await relink()).relinkTrees([mjsTree.mainDir, mjsTree.uiDir], () => {});
  const fromMjs = linkMap(rootMjs);

  assert.deepEqual(fromMjs, fromTs, "两份实现产出的链接映射必须逐条相同");
  // 顺带确认这棵树确实触发了重链（否则「两边都什么都没做」也会过）
  assert.deepEqual(Object.keys(fromTs).sort(), [
    "t/sati-main/node_modules/.pnpm/foo@1.0.0/node_modules/isolated-dep",
    "t/sati-main/node_modules/@scope/baz",
    "t/sati-main/node_modules/foo",
    "t/sati-main/node_modules/qux",
    "t/satiui/node_modules/bar",
  ]);
  fs.rmSync(rootTs, { recursive: true, force: true });
  fs.rmSync(rootMjs, { recursive: true, force: true });
});

test("mjs 版覆盖范围是运行时版的超集（workspace 包内的 node_modules）", async () => {
  const rootTs = tmpRoot();
  const tsTree = buildTree(path.join(rootTs, "t"), true);
  reconstructPnpmLinks(tsTree.mainDir, [tsTree.uiDir]);
  const fromTs = linkMap(rootTs);

  const rootMjs = tmpRoot();
  const mjsTree = buildTree(path.join(rootMjs, "t"), true);
  (await relink()).relinkTrees([mjsTree.mainDir, mjsTree.uiDir], () => {});
  const fromMjs = linkMap(rootMjs);

  const wsPath = "t/sati-main/packages/ws-a/node_modules/foo";
  assert.ok(wsPath in fromMjs, "mjs 版应覆盖 workspace 包内部的 node_modules");
  assert.ok(!(wsPath in fromTs), "运行时版从固定种子集合 BFS，不应走到这里");
  // 交集必须完全一致（这是本用例真正要守的：超集之上不得出现取值分歧）
  for (const [key, value] of Object.entries(fromTs)) {
    assert.equal(fromMjs[key], value, `共享覆盖点上取值分歧：${key}`);
  }
  fs.rmSync(rootTs, { recursive: true, force: true });
  fs.rmSync(rootMjs, { recursive: true, force: true });
});

test("自身没有 .pnpm 的树借用兄弟树的 vstore（此前被整体跳过）", async () => {
  const root = tmpRoot();
  const { mainDir, uiDir } = buildTree(path.join(root, "t"));
  const uiPkg = path.join(uiDir, "node_modules", "bar");
  assert.equal(fs.lstatSync(uiPkg).isSymbolicLink(), false, "前置：satiui 侧初始是实目录");

  (await relink()).relinkTrees([mainDir, uiDir], () => {});

  assert.equal(fs.lstatSync(uiPkg).isSymbolicLink(), true, "satiui 侧应被借 vstore 重链");
  assert.equal(
    // realpath 归一：macOS 的 tmpdir 是 /var → /private/var 的软链
    path.relative(fs.realpathSync(root), fs.realpathSync(uiPkg)),
    "t/sati-main/node_modules/.pnpm/bar@2.0.0/node_modules/bar",
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("两版都跳过 pnpm 公共 hoist 根（只重复 vstore）", async () => {
  const root = tmpRoot();
  const { mainDir, uiDir } = buildTree(path.join(root, "t"));
  const hoist = path.join(mainDir, "node_modules", ".pnpm", "node_modules", "bar");

  reconstructPnpmLinks(mainDir, [uiDir]);

  assert.equal(fs.lstatSync(hoist).isSymbolicLink(), false);
  fs.rmSync(root, { recursive: true, force: true });
});
