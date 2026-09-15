import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { reconstructPnpmLinks, stageRuntimeLayout } from "../../apps/desktop/src/runtime-layout.js";

/**
 * runtime-layout 的行为锚。
 *
 * 这两段接线原先长在 ServerManager 的私有作用域里（`resolvePaths()` 内联块 +
 * 私有方法），只能经 Electron 启动才触达 ⇒ 零直测。抽出后可用合成树直接驱动，
 * 于是「删掉一条链接」「重链跳过条件被放宽」这类改动会红在这里，而不是红在
 * 用户装完之后。
 *
 * 刻意**不**用 process.platform 覆写去测 win32 分支：`symlinkSync(..., "junction")`
 * 在非 Windows 上由 libuv 决定行为，跨 CI 平台不稳。win32 分支的正确性由
 * `scripts/scratch-derive-348.py` 的等价性核对（逐行相同）保证。
 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sati-layout-"));
}

/**
 * 逐条收集目录树里的符号链接 → 目标（相对 base）。
 *
 * 不进入符号链接（否则会把 vstore 整棵树走穿）；base 取 realpath，因为 macOS 的
 * tmpdir 是 /var → /private/var 的软链，不归一化会算出满屏 `../../..`。
 */
function snapshotLinks(base: string): Record<string, string> {
  const out: Record<string, string> = {};
  const realBase = fs.realpathSync(base);
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
        out[relPath] = path.relative(realBase, fs.realpathSync(abs)) || ".";
        continue;
      }
      if (st.isDirectory()) walk(abs, relPath);
    }
  };
  walk(base, "");
  return out;
}

function mkdirp(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p: string, value: unknown): void {
  mkdirp(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(value));
}

/** 造一棵最小可跑的运行时树：三份 bundle 解包目录 + sati-main 的 dist/node_modules。 */
function makeRuntimeTree() {
  const base = tmpRoot();
  const satiMainDir = path.join(base, "sati-main");
  const satiUiDir = path.join(base, "satiui");
  const satiMemoryDir = path.join(base, "sati-memory-core");
  mkdirp(path.join(satiMainDir, "dist", "src", "context", "memory"));
  mkdirp(path.join(satiMainDir, "node_modules"));
  mkdirp(path.join(satiUiDir, "server"));
  mkdirp(path.join(satiMemoryDir, "lib"));
  fs.writeFileSync(path.join(satiMemoryDir, "lib", "index.js"), "module.exports = {};\n");
  return { base, satiMainDir, satiUiDir, satiMemoryDir };
}

// ─────────────────────────── stageRuntimeLayout ───────────────────────────

test("stageRuntimeLayout 铺出运行时解析所需的全部符号链接", () => {
  const { base, satiMainDir, satiMemoryDir } = makeRuntimeTree();

  stageRuntimeLayout({ runtimeBaseDir: base, satiMainDir, satiMemoryDir });

  assert.deepEqual(snapshotLinks(base), {
    dist: "sati-main/dist",
    node_modules: "sati-main/node_modules",
    src: "sati-main/dist/src",
    "sati-main/node_modules/edgeclaw-memory-core": "sati-memory-core",
    "sati-main/dist/src/context/memory/edgeclaw-memory-core": "sati-memory-core",
  });
  fs.rmSync(base, { recursive: true, force: true });
});

test("stageRuntimeLayout 幂等：重复调用不改动已有链接", () => {
  const { base, satiMainDir, satiMemoryDir } = makeRuntimeTree();
  const input = { runtimeBaseDir: base, satiMainDir, satiMemoryDir };

  stageRuntimeLayout(input);
  const first = snapshotLinks(base);
  stageRuntimeLayout(input);

  assert.deepEqual(snapshotLinks(base), first);
  fs.rmSync(base, { recursive: true, force: true });
});

test("stageRuntimeLayout 用链接替换 sati-main 产物里的 memory-core 空壳目录", () => {
  const { base, satiMainDir, satiMemoryDir } = makeRuntimeTree();
  const stub = path.join(satiMainDir, "dist", "src", "context", "memory", "edgeclaw-memory-core");
  mkdirp(path.join(stub, "src"));
  fs.writeFileSync(path.join(stub, "src", "index.ts"), "export {};\n");

  stageRuntimeLayout({ runtimeBaseDir: base, satiMainDir, satiMemoryDir });

  // 空壳被换成链接：其下不再有 tsc 产出的 src/index.ts
  assert.equal(fs.lstatSync(stub).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(stub), fs.realpathSync(satiMemoryDir));
  assert.equal(fs.existsSync(path.join(stub, "src", "index.ts")), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("stageRuntimeLayout 目标不存在时留空：memory-core 缺 lib 也不建链接", () => {
  const { base, satiMainDir } = makeRuntimeTree();
  const stub = path.join(satiMainDir, "dist", "src", "context", "memory", "edgeclaw-memory-core");
  mkdirp(stub);
  // 传一个**不存在**的 memory-core 解包目录（三份 tar 解压失败/缺件时的形态）
  const satiMemoryDir = path.join(base, "absent-memory-core");

  stageRuntimeLayout({ runtimeBaseDir: base, satiMainDir, satiMemoryDir });

  // 壳目录先被删、链接又因目标缺失而未建 —— 这是原实现的既有行为，此处锁定它
  assert.equal(fs.existsSync(stub), false);
  assert.equal(fs.existsSync(path.join(satiMainDir, "node_modules", "edgeclaw-memory-core")), false);
  // 其余两条不依赖 memory-core 的链接照常建立
  assert.equal(fs.lstatSync(path.join(base, "dist")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(base, "src")).isSymbolicLink(), true);
  fs.rmSync(base, { recursive: true, force: true });
});

// ───────────────────────── reconstructPnpmLinks ───────────────────────────

/** 造一条 vstore 记录：`.pnpm/<enc>@<ver>/node_modules/<name>` 带真实 package.json。 */
function putVstore(root: string, name: string, version: string): string {
  const enc = name.startsWith("@") ? name.replace("/", "+") : name;
  const dir = path.join(root, "node_modules", ".pnpm", `${enc}@${version}`, "node_modules", name);
  writeJson(path.join(dir, "package.json"), { name, version });
  return dir;
}

/** 造一个「解包后落成实目录」的包（Windows bsdtar 的产物形态）。 */
function putRealPackage(nmDir: string, name: string, version?: string): string {
  const dir = path.join(nmDir, name);
  mkdirp(dir);
  if (version !== undefined) fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version }));
  return dir;
}

test("reconstructPnpmLinks 把实目录包重链到 vstore 规范位置", () => {
  const base = tmpRoot();
  const vstore = putVstore(base, "foo", "1.0.0");
  const real = putRealPackage(path.join(base, "node_modules"), "foo", "1.0.0");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.lstatSync(real).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(real), fs.realpathSync(vstore));
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 处理 scoped 包（@scope+name 编码）", () => {
  const base = tmpRoot();
  const vstore = putVstore(base, "@scope/bar", "2.3.4");
  const real = putRealPackage(path.join(base, "node_modules"), "@scope/bar", "2.3.4");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.lstatSync(real).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(real), fs.realpathSync(vstore));
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 不动已有的符号链接（幂等前提）", () => {
  const base = tmpRoot();
  putVstore(base, "foo", "1.0.0");
  const elsewhere = path.join(base, "keep-me");
  mkdirp(elsewhere);
  const link = path.join(base, "node_modules", "foo");
  mkdirp(path.dirname(link));
  fs.symlinkSync(elsewhere, link);

  reconstructPnpmLinks(base, []);

  assert.equal(fs.realpathSync(link), fs.realpathSync(elsewhere));
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 版本对不上且有多个候选时保持实目录", () => {
  const base = tmpRoot();
  putVstore(base, "foo", "1.0.0");
  putVstore(base, "foo", "2.0.0");
  const real = putRealPackage(path.join(base, "node_modules"), "foo", "3.0.0");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.lstatSync(real).isSymbolicLink(), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 唯一候选时版本不一致也回退链上（既有弱化行为）", () => {
  const base = tmpRoot();
  const vstore = putVstore(base, "foo", "1.0.0");
  const real = putRealPackage(path.join(base, "node_modules"), "foo", "9.9.9");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.realpathSync(real), fs.realpathSync(vstore));
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 跳过没有 package.json 的目录、.pnpm 与 .bin", () => {
  const base = tmpRoot();
  putVstore(base, "foo", "1.0.0");
  const noManifest = putRealPackage(path.join(base, "node_modules"), "no-manifest");
  putRealPackage(path.join(base, "node_modules"), ".bin", "1.0.0");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.lstatSync(noManifest).isSymbolicLink(), false);
  assert.equal(fs.lstatSync(path.join(base, "node_modules", ".bin")).isSymbolicLink(), false);
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 也处理 extraRoots 与 vstore 内部的嵌套 node_modules", () => {
  const base = tmpRoot();
  const ui = path.join(base, "satiui");
  // 顶层：sati-main 侧
  const mainVstore = putVstore(base, "shared", "1.0.0");
  const mainReal = putRealPackage(path.join(base, "node_modules"), "shared", "1.0.0");
  // extraRoots：satiui 侧的同名包（共享同一棵 vstore 是不可能的，这里只验「会被访问」）
  mkdirp(path.join(ui, "node_modules"));
  const uiReal = putRealPackage(path.join(ui, "node_modules"), "shared", "1.0.0");
  // vstore 内部：某个包自己的 node_modules 里也躺着实目录
  const innerNm = path.join(base, "node_modules", ".pnpm", "dep@0.1.0", "node_modules");
  const innerReal = putRealPackage(innerNm, "shared", "1.0.0");

  reconstructPnpmLinks(base, [ui]);

  assert.equal(fs.realpathSync(mainReal), fs.realpathSync(mainVstore));
  assert.equal(fs.realpathSync(uiReal), fs.realpathSync(mainVstore));
  assert.equal(fs.realpathSync(innerReal), fs.realpathSync(mainVstore));
  fs.rmSync(base, { recursive: true, force: true });
});

test("reconstructPnpmLinks 在非 pnpm 布局下直接返回", () => {
  const base = tmpRoot();
  const real = putRealPackage(path.join(base, "node_modules"), "foo", "1.0.0");

  reconstructPnpmLinks(base, []);

  assert.equal(fs.lstatSync(real).isSymbolicLink(), false);
  fs.rmSync(base, { recursive: true, force: true });
});
