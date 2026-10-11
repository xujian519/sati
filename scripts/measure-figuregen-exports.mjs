#!/usr/bin/env node
/**
 * M9 判据：figuregen barrel 导出面统计（全库零消费导出扫描）。
 *
 * 背景：docs/technical-debt/backlog.md 与 issue #541 记录「figuregen barrel 的零消费导出」，
 * 45 天 sweep（issue #646 · 计划 §5 P1.5 / §3 M9）要求把该数字**脚本化**——此前 88/92/84
 * 三个口径都来自一次性人工侦察，P5 终审无法机械复算。
 *
 * 口径（与 P0.2 冻结）：
 *   - 导出面 = `src/patent/figuregen/index.ts` 的导出名（含 `export * from "./cad/index.js"`
 *     展开的 cad barrel），含值导出与类型导出。
 *   - 「零消费」= 该导出名在 **figuregen 模块之外**的仓库源码中被 import / 再导出 /
 *     动态 import 解构引用过 **且仅** 在上述形态中出现为 false：不统计 barrel 自身与模块内引用。
 *   - 扫描面：src · ui · tests · scripts · apps（排除 node_modules/dist/.git 与
 *     src/patent/figuregen/ 子树）。
 *   - 扫描形态：具名 import（含 `type` 前缀与 `as` 别名，按「导入名」计数）、`export {} from`
 *     再导出、`import * as ns` + `ns.NAME` 命名空间访问、动态 `import(...)` 后紧跟的 `{...}` 解构。
 *
 * 基线：本脚本**首跑 2026-10-12 = 235 个导出名 / 84 个零消费**，自此为 M9 唯一判据
 * （此前一次性人工侦察口径：2026-10-11 记 88；issue #541 记 92——两数均被本脚本取代，差值为口径差）。
 * sweep 的 M9 目标：零消费 → 0（删除 / 降测试专用 / 保留并说明）。
 * **2026-10-12 P1.5 达成：154 / 154 全消费、0 零消费**（84 名裁剪出 barrel + 深引全部归一，
 * 决策见 docs/notes/implemented/2026-10-12-figuregen-barrel-convergence.md）。
 *
 * 用法：
 *   node scripts/measure-figuregen-exports.mjs          # 人读报告
 *   node scripts/measure-figuregen-exports.mjs --json   # 机器可读
 *
 * 说明：本脚本是 informational（未挂门禁）；sweep 收口后可作为防回潮门禁的候选。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const FIGUREGEN_DIR = join(ROOT, "src/patent/figuregen");
const BARRELS = [join(FIGUREGEN_DIR, "index.ts"), join(FIGUREGEN_DIR, "cad/index.ts")];

const SCAN_DIRS = ["src", "ui", "tests", "scripts", "apps"];
const SKIP_DIRS = new Set(["node_modules", "dist", ".git", "lib", "ui-source"]);
const EXTS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (EXTS.has(p.slice(p.lastIndexOf(".")))) out.push(p);
  }
  return out;
}

/** 解析一个 barrel 文件的导出名（含 export * 递归，深度 ≤3，仅 figuregen 内）。 */
function collectExports(file, depth, seen, into) {
  if (depth > 3 || seen.has(file)) return;
  seen.add(file);
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return;
  }
  const rel = relative(FIGUREGEN_DIR, file);
  // 具名块：export { ... } from / export type { ... } from
  const blockRe = /export\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
  let m;
  while ((m = blockRe.exec(text))) {
    const blockTypeOnly = Boolean(m[1]);
    for (const raw of m[2].split(",")) {
      const entry = raw.trim();
      if (!entry) continue;
      const typeOnly = blockTypeOnly || /^type\s/.test(entry);
      const cleaned = entry.replace(/^type\s+/, "");
      const exported = cleaned.includes(" as ") ? cleaned.split(/\s+as\s+/)[1].trim() : cleaned;
      if (!/^[A-Za-z0-9_$]+$/.test(exported)) continue;
      if (!into.has(exported)) into.set(exported, { file: rel, typeOnly });
    }
  }
  // export * from "./x.js"（仅 figuregen 内部）
  const starRe = /export\s+\*\s+from\s+["']([^"']+)["']/g;
  while ((m = starRe.exec(text))) {
    const spec = m[1];
    if (!spec.startsWith(".")) continue;
    const target = resolve(join(file, ".."), spec.replace(/\.js$/, ".ts"));
    if (target.startsWith(FIGUREGEN_DIR)) collectExports(target, depth + 1, seen, into);
  }
  // 直接声明：export const/function/class/interface/type NAME
  const declRe = /export\s+(?:declare\s+)?(const|let|function|class|interface|enum|type)\s+([A-Za-z0-9_$]+)/g;
  while ((m = declRe.exec(text))) {
    const isType = m[1] === "interface" || m[1] === "type";
    if (!into.has(m[2])) into.set(m[2], { file: rel, typeOnly: isType });
  }
}

function collectConsumed() {
  const consumed = new Set();
  const files = SCAN_DIRS.flatMap(d => walk(join(ROOT, d))).filter(f => !f.startsWith(FIGUREGEN_DIR + "/"));
  for (const f of files) {
    let text;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    // 具名 import / 再导出（export {..} from）
    const namedRe = /(?:import|export)\s+(type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;
    let m;
    while ((m = namedRe.exec(text))) {
      if (!m[3].includes("figuregen")) continue;
      for (const raw of m[2].split(",")) {
        const entry = raw.trim().replace(/^type\s+/, "");
        if (!entry) continue;
        const imported = entry.includes(" as ") ? entry.split(/\s+as\s+/)[0].trim() : entry;
        if (/^[A-Za-z0-9_$]+$/.test(imported)) consumed.add(imported);
      }
    }
    // import * as ns from "...figuregen..."
    const nsRe = /import\s+\*\s+as\s+([A-Za-z0-9_$]+)\s+from\s+["']([^"']+)["']/g;
    while ((m = nsRe.exec(text))) {
      if (!m[2].includes("figuregen")) continue;
      const varName = m[1];
      const useRe = new RegExp(`\\b${varName}\\.([A-Za-z0-9_$]+)`, "g");
      let u;
      while ((u = useRe.exec(text))) consumed.add(u[1]);
    }
    // 动态 import(...) 后 300 字符内的 {...} 解构（保守放行）
    const dynRe = /import\(\s*["']([^"']*figuregen[^"']*)["']\s*\)/g;
    while ((m = dynRe.exec(text))) {
      const after = text.slice(m.index, m.index + 400);
      const brace = after.match(/\{([^}]*)\}/);
      if (brace) {
        for (const raw of brace[1].split(",")) {
          const name = raw.trim().split(/[:\s]/)[0];
          if (/^[A-Za-z0-9_$]+$/.test(name)) consumed.add(name);
        }
      }
    }
  }
  return consumed;
}

function main() {
  const exportsMap = new Map();
  for (const b of BARRELS) collectExports(b, 0, new Set(), exportsMap);
  const consumed = collectConsumed();

  const zero = [...exportsMap.entries()]
    .filter(([name]) => !consumed.has(name))
    .map(([name, meta]) => ({ name, ...meta }))
    .sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file.localeCompare(b.file)));

  const values = [...exportsMap.values()].filter(v => !v.typeOnly).length;
  const types = exportsMap.size - values;

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        {
          total: exportsMap.size,
          values,
          types,
          consumed: exportsMap.size - zero.length,
          zeroConsumption: zero.length,
          zeroList: zero,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("figuregen barrel 导出面统计（M9 判据 · informational）");
  console.log(`  导出名总数: ${exportsMap.size}（值 ${values} · 类型 ${types}）`);
  console.log(`  模块外已消费: ${exportsMap.size - zero.length}`);
  console.log(`  零消费: ${zero.length}`);
  if (zero.length) {
    const byFile = new Map();
    for (const z of zero) {
      if (!byFile.has(z.file)) byFile.set(z.file, []);
      byFile.get(z.file).push(z);
    }
    for (const [file, list] of [...byFile.entries()].sort()) {
      console.log(`\n  ${file}（${list.length}）`);
      for (const z of list) console.log(`    - ${z.name}${z.typeOnly ? "（type）" : ""}`);
    }
  }
}

main();
