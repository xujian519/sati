#!/usr/bin/env node
/**
 * Sati Windows pnpm link reconstruction for L1 artifact smoke.
 *
 * Mirrors server-manager.ts reconstructPnpmLinks() (and extends it): on
 * Windows, bsdtar FOLLOWS pnpm's vstore junctions while archiving node_modules
 * but materializes only ONE junction level. The extracted tree therefore has
 * real directories where pnpm placed junctions, and a materialized copy's own
 * nested junctions were archived as empty dirs — so isolated transitive deps
 * are unreachable (e.g. @google/genai -> p-retry -> retry throws
 * ERR_MODULE_NOT_FOUND at startup).
 *
 * This script makes every real package dir in the tree a junction to its
 * canonical `.pnpm/<enc>@<version>/node_modules/<name>` vstore location —
 * exactly the layout pnpm has in the dev tree — by walking every node_modules
 * directory (top-level, workspace packages, and vstore dep roots alike).
 * Idempotent: existing junctions/symlinks are skipped. Safe on any platform.
 *
 * Usage (from repo root, with the bundled Node):
 *   node apps\desktop\scripts\relink-pnpm-win.mjs <extractedMainDir> [<extractedUiDir> ...]
 */
import * as fs from "node:fs";
import path from "node:path";

const encode = name => (name.startsWith("@") ? name.replace("/", "+") : name);

function versionOf(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function tryLink(pnpmDir, pkgDir, name) {
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

function relinkNodeModulesDir(nm, pnpmDir) {
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
      for (const child of scopeEntries) {
        tryLink(pnpmDir, path.join(p, child), `${e}/${child}`);
      }
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
function collectNodeModulesDirs(root, pnpmDir) {
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

for (const treeDir of process.argv.slice(2)) {
  const nm = path.join(treeDir, "node_modules");
  const pnpmDir = path.join(nm, ".pnpm");
  if (!fs.existsSync(pnpmDir)) {
    console.log(`  relink: skip ${treeDir} (no .pnpm store)`);
    continue;
  }
  for (const dir of collectNodeModulesDirs(treeDir, pnpmDir)) {
    relinkNodeModulesDir(dir, pnpmDir);
  }
  console.log(`  relink: ${treeDir} ok`);
}
