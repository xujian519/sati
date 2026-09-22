// scripts/lib/import-specifiers.mjs
// 从源码文本里**精确**提取模块 specifier（`import` / `export … from` / `import()` / `require()` /
// `import x = require()`），供架构边界门禁判断依赖方向。
//
// 为什么用 TS 编译器而不是「先删字符串再正则」（2026-09-22 的既有缺陷）：
// `check-ui-server-boundary.mjs` 原先先跑一遍状态机把注释**和字符串字面量**整体置空，再匹配
// 带引号的 specifier —— 而 specifier 本身就在字符串里，置空后正则永远匹配不到，门禁长期空转
// （实测：伪造 `ui/server → src/patent/…` 深层导入仍输出 fresh）。这属于「会误报/不报的门禁比
// 没有更糟」。改为 AST 提取后：注释与字符串里的假 import 天然不在语法树里（零误报），
// 模板字面量 `${}` 内的真实 import 也不漏（零漏报）。
//
// 这里只做**语法层**提取（specifier 字面量的文本与位置），不做模块解析——路径解析仍由各门禁
// 自己的纯路径逻辑完成（原脚本拒绝 eslint resolver 的理由是 .js→.ts 回退问题，与解析字面量无关）。
// typescript 是 devDependency（scripts/measure-techdebt.mjs 等既有门禁同样依赖它）。

import ts from "typescript";

/** 扩展名 → TS ScriptKind（JS 语法按 JS/JSX 解析，TS 语法按 TS/TSX 解析）。 */
const SCRIPT_KIND_BY_EXTENSION = new Map([
  [".ts", ts.ScriptKind.TS],
  [".mts", ts.ScriptKind.TS],
  [".cts", ts.ScriptKind.TS],
  [".tsx", ts.ScriptKind.TSX],
  [".js", ts.ScriptKind.JS],
  [".mjs", ts.ScriptKind.JS],
  [".cjs", ts.ScriptKind.JS],
  [".jsx", ts.ScriptKind.JSX],
]);

export function scriptKindOf(filePath) {
  const dot = filePath.lastIndexOf(".");
  return SCRIPT_KIND_BY_EXTENSION.get(dot === -1 ? "" : filePath.slice(dot)) ?? ts.ScriptKind.TS;
}

/**
 * 提取所有模块 specifier。
 *
 * @param {string} filePath 用于选择解析语法的文件名（相对路径即可）
 * @param {string} source 源码文本
 * @returns {{ specifier: string, offset: number }[]} offset 为 specifier 字面量起点（换算行号用）
 */
export function extractModuleSpecifiers(filePath, source) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, false, scriptKindOf(filePath));
  /** @type {{ specifier: string, offset: number }[]} */
  const out = [];
  const addLiteral = node => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      out.push({ specifier: node.text, offset: node.getStart(sourceFile) });
    }
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      addLiteral(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      addLiteral(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(callee) && callee.text === "require";
      if ((isDynamicImport || isRequire) && node.arguments.length > 0) {
        addLiteral(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** 相对 specifier（`.`/`..` 开头）——只有这类才需要按文件目录解析。 */
export function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

/** 由源码与 offset 换算 1 基行号。 */
export function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}
