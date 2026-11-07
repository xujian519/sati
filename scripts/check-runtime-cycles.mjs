// scripts/check-runtime-cycles.mjs
// 静态初始化期循环依赖门禁（#807）。
//
// 与 madge --circular 的口径对齐：只看 `import` / `export … from` / `import = require`
// 这类**模块初始化时求值**的边。`import type` 在编译后消失，`await import()` 是惰性求值，
// 两者都不构成初始化期环，因此不计入（把它们算进来会把已有的、刻意的环打断策略误报成回归）。
//
// 解析规则：相对 specifier → `.ts` / `.tsx` / `index.ts`；Emitted JS 的 `.js` 回退到 `.ts`。

import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");

function scriptKindOf(filePath) {
  return filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
}

/** 提取初始化期会求值的相对模块 specifier。 */
function staticSpecifiers(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, scriptKindOf(filePath));
  const out = [];
  const add = node => {
    if (node !== undefined && ts.isStringLiteralLike(node)) out.push(node.text);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      if (!node.importClause?.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      if (!node.isTypeOnly) add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (!node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/**
 * @param {string[]} files 绝对路径
 * @param {(file: string) => string} readFile
 * @returns {string[][]} 初始化期强连通分量（只含 >1 文件的环）
 */
export function findStaticCycles(files, readFile) {
  const fileSet = new Set(files);
  const resolveSpec = (fromFile, specifier) => {
    if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null;
    const base = path.resolve(path.dirname(fromFile), specifier);
    const candidates = base.endsWith(".js")
      ? [base.slice(0, -3) + ".ts", base.slice(0, -3) + ".tsx", path.join(base.slice(0, -3), "index.ts")]
      : [base + ".ts", base + ".tsx", path.join(base, "index.ts")];
    return candidates.find(candidate => fileSet.has(candidate)) ?? null;
  };

  const graph = new Map();
  for (const file of files) {
    const deps = new Set();
    for (const specifier of staticSpecifiers(file, readFile(file))) {
      const resolved = resolveSpec(file, specifier);
      if (resolved !== null) deps.add(resolved);
    }
    graph.set(file, [...deps]);
  }

  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];

  const strongConnect = vertex => {
    indices.set(vertex, index);
    low.set(vertex, index);
    index++;
    stack.push(vertex);
    onStack.add(vertex);
    for (const next of graph.get(vertex) ?? []) {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(vertex, Math.min(low.get(vertex), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(vertex, Math.min(low.get(vertex), indices.get(next)));
      }
    }
    if (low.get(vertex) === indices.get(vertex)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== vertex);
      if (component.length > 1) cycles.push(component);
    }
  };

  for (const vertex of graph.keys()) {
    if (!indices.has(vertex)) strongConnect(vertex);
  }
  return cycles.sort((a, b) => b.length - a.length);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const srcDir = path.join(root, "src");
  const cycles = findStaticCycles(walk(srcDir), file => fs.readFileSync(file, "utf8"));
  if (cycles.length === 0) {
    console.log("✅ no init-time circular dependencies in src/");
    process.exit(0);
  }
  console.error(`❌ found ${cycles.length} init-time circular dependency group(s):`);
  for (const group of cycles) {
    console.error(`\n--- ${group.length} files ---`);
    for (const file of group.sort()) console.error(`  ${path.relative(root, file)}`);
  }
  process.exit(1);
}
