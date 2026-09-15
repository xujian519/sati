#!/usr/bin/env node
/**
 * Sati Windows pnpm link reconstruction for L1 artifact smoke.
 *
 * 与 `apps/desktop/src/runtime-layout.ts` 的 `reconstructPnpmLinks()` **同源**：
 * Windows 上 bsdtar FOLLOWS pnpm 的 vstore junction 归档 node_modules，但只物化
 * 一层 junction ⇒ 解包树里 pnpm 放 junction 的位置变成实目录，且被物化副本自己的
 * 嵌套 junction 归档成了空目录，于是隔离的传递依赖不可达
 * （如 `@google/genai` -> `p-retry` -> `retry` 启动即 ERR_MODULE_NOT_FOUND）。
 *
 * 本脚本把树里每个实包目录 junction 回 `.pnpm/<enc>@<version>/node_modules/<name>`
 * 的规范位置，还原 pnpm 在开发树里的布局。幂等：已有的 junction/符号链接跳过。
 *
 * 与运行时版的两处**刻意**差异（都由 tests/desktop/pnpm-vstore-relink-parity.spec.ts 锁定）：
 *   1. 覆盖范围是**超集**：运行时版从三个种子集合出发做 BFS（`<root>/node_modules`、
 *      各 extraRoots 的 `node_modules`、`.pnpm/<pkg>/node_modules`），本脚本遍历树里
 *      **所有** node_modules 目录（含 workspace 包内部的那层）。
 *   2. 借用 vstore：运行时版把 `[satiUiDir, satiMemoryDir]` 作为 extraRoots 用
 *      **sati-main 的 vstore** 去补——本脚本原先对自身没有 `.pnpm` 的树直接整体跳过，
 *      于是 satiui 的实目录包在验证时从未被重链（**验证比运行时弱**）。现改为同样的借用
 *      语义。
 *
 * 用法（仓库根，用打包的 Node）：
 *   node apps\desktop\scripts\relink-pnpm-win.mjs <extractedMainDir> [<extractedUiDir> ...]
 */
import * as fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const encode = name => (name.startsWith("@") ? name.replace("/", "+") : name);

export function versionOf(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export function tryLink(pnpmDir, pkgDir, name) {
  let st;
  try {
    st = fs.lstatSync(pkgDir);
  } catch {
    return;
  }
  // Leave real symlinks/junctions alone (macOS/Linux trees).
  if (st.isSymbolicLink() || st.isFile()) return;
  const ver = versionOf(pkgDir);
  if (!ver) return;

  let candidates;
  try {
    candidates = fs.readdirSync(pnpmDir).filter(d => d.startsWith(`${encode(name)}@`));
  } catch {
    return;
  }
  if (candidates.length === 0) return;
  const pick = candidates.find(c => c === `${encode(name)}@${ver}`) ?? (candidates.length === 1 ? candidates[0] : null);
  if (!pick) return;

  const target = path.join(pnpmDir, pick, "node_modules", name);
  if (!fs.existsSync(target)) return;
  if (path.resolve(target) === path.resolve(pkgDir)) return;
  try {
    fs.rmSync(pkgDir, { recursive: true, force: true });
    fs.symlinkSync(target, pkgDir, "junction");
  } catch {
    /* best-effort: locked dirs are left as real dirs */
  }
}

export function relinkNodeModulesDir(nm, pnpmDir) {
  let entries;
  try {
    entries = fs.readdirSync(nm);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === ".pnpm" || e === ".bin") continue;
    const p = path.join(nm, e);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (e.startsWith("@")) {
      let scopeEntries;
      try {
        scopeEntries = fs.readdirSync(p);
      } catch {
        continue;
      }
      // 不在此处筛 isDirectory：tryLink 内部对符号链接/文件会自行返回
      for (const child of scopeEntries) tryLink(pnpmDir, path.join(p, child), `${e}/${child}`);
    } else if (st.isDirectory()) {
      tryLink(pnpmDir, p, e);
    }
  }
}

// Collect every node_modules directory under the tree (top-level, workspace
// packages, vstore dep roots), then relink each. The hoist root
// (.pnpm/node_modules) is skipped: it only duplicates the vstore and is
// absent from the dedup tars anyway. A visited set guards against junction
// loops in the canonical store.
export function collectNodeModulesDirs(root, pnpmDir) {
  const dirs = [];
  const visited = new Set();
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const p = path.join(dir, ent.name);
      if (ent.name === "node_modules") {
        // Skip the hoist root (.pnpm/node_modules): it duplicates the vstore
        // and is absent from the dedup tars anyway.
        if (path.resolve(p) === path.resolve(path.join(pnpmDir, "node_modules"))) continue;
        dirs.push(p);
      }
      // Descend into everything (incl. node_modules dirs): vstore dep roots
      // and workspace-package node_modules live one level inside.
      stack.push(p);
    }
  }
  return dirs;
}

/**
 * 对一组解包树做重链，语义与运行时的 `reconstructPnpmLinks(root, extraRoots)` 对齐：
 * 先挑出**自带 vstore**的树作 owner，其余树借用它的 vstore。
 *
 * @param {string[]} treeDirs 解包出的树，顺序即运行时传 extraRoots 的顺序
 * @param {(message: string) => void} [log] 输出口（供用例静音）
 */
export function relinkTrees(treeDirs, log = console.log) {
  const owner = treeDirs.find(dir => fs.existsSync(path.join(dir, "node_modules", ".pnpm")));
  if (!owner) {
    for (const dir of treeDirs) log(`  relink: skip ${dir} (no .pnpm store)`);
    return;
  }
  const ownerPnpmDir = path.join(owner, "node_modules", ".pnpm");
  for (const treeDir of treeDirs) {
    const ownPnpmDir = path.join(treeDir, "node_modules", ".pnpm");
    const selfHosted = ownPnpmDir === ownerPnpmDir;
    const pnpmDir = selfHosted ? ownPnpmDir : ownerPnpmDir;
    for (const dir of collectNodeModulesDirs(treeDir, pnpmDir)) {
      relinkNodeModulesDir(dir, pnpmDir);
    }
    log(`  relink: ${treeDir} ok${selfHosted ? "" : ` (borrowing ${path.basename(owner)}/.pnpm)`}`);
  }
}

// 仅在被当作 CLI 执行时跑（被 import 时只导出，供一致性用例驱动）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  relinkTrees(process.argv.slice(2));
}
