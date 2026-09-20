import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

/**
 * 专利域工具的 domain 存在**双约定**：一部分 creator 在定义里自标 `domain: "patent"`
 * （如 `builtin/patentSearch.ts`），另一部分依赖注册表集中打标
 * （`createBuiltinRegistry.ts` 的 `annotate(..., "patent")`）。`annotate` 只补不覆盖
 * （`createBuiltinRegistry.ts:119-121`），所以 creator 一旦自标**别的域**，注册表的
 * 意图会被静默覆盖——表现为该工具从专利域消失、且数量与文档口径不符。
 *
 * 本测试把两侧对拍：注册表 AST 声明的专利域站点数 == 运行期实际 `domain === "patent"`
 * 的工具数（声明侧与运行侧各自独立生产，非同源恒真）。带 `documentStyle` 门的两个
 * 排版面板工具是 opt-in，不计入默认注册数。
 */
const REPO_ROOT = (() => {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found (no package.json ancestor)");
    dir = parent;
  }
  return dir;
})();

const REGISTRY_PATH = join(REPO_ROOT, "src", "tool", "registry", "createBuiltinRegistry.ts");
const DOMAIN_TYPES_PATH = join(REPO_ROOT, "src", "tool", "protocol", "types.ts");

/** 默认注册路径之外的工具组：落在这些 `if (options?.<key>)` 门内的 annotate 不计入。 */
const GATED_OPTION_KEYS = new Set([
  "documentStyle",
  "workspaceLedgerTools",
  "backgroundTasks",
  "memory",
  "readSkill",
  "team",
  "kanban",
]);

function parseSource(path: string): ts.SourceFile {
  return ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
}

/** `ToolDomain` 联合的字面量成员（含 `team:manage` 这类带冒号的字面量）。 */
function toolDomainUnion(): string[] {
  const source = parseSource(DOMAIN_TYPES_PATH);
  const domains: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === "ToolDomain") {
      const collect = (child: ts.Node): void => {
        if (ts.isLiteralTypeNode(child) && ts.isStringLiteral(child.literal)) domains.push(child.literal.text);
        child.forEachChild(collect);
      };
      collect(node.type);
    }
    node.forEachChild(visit);
  };
  visit(source);
  return domains;
}

/** 收集 `annotate(<expr>, "<domain>")` 调用点；落入 opt-in 门内的不计。 */
function collectAnnotateDomains(): Array<{ domain: string; line: number }> {
  const source = parseSource(REGISTRY_PATH);
  const found: Array<{ domain: string; line: number }> = [];

  /** 条件里 `options?.<key>` 的 key（取首个）。 */
  const optionKeyOf = (node: ts.Expression): string | undefined => {
    let key: string | undefined;
    const visit = (child: ts.Node): void => {
      if (
        key === undefined &&
        ts.isPropertyAccessExpression(child) &&
        ts.isIdentifier(child.expression) &&
        child.expression.text === "options"
      ) {
        key = child.name.text;
      }
      child.forEachChild(visit);
    };
    visit(node);
    return key;
  };

  const visit = (node: ts.Node, gated: boolean): void => {
    if (ts.isIfStatement(node)) {
      const key = optionKeyOf(node.expression);
      const thenGated = gated || (key !== undefined && GATED_OPTION_KEYS.has(key));
      node.thenStatement.forEachChild(child => visit(child, thenGated));
      if (node.elseStatement !== undefined) visit(node.elseStatement, gated);
      return;
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "annotate") {
      const domainArg = node.arguments[1];
      if (domainArg !== undefined && ts.isStringLiteral(domainArg) && !gated) {
        const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart(source));
        found.push({ domain: domainArg.text, line: line + 1 });
      }
    }
    node.forEachChild(child => visit(child, gated));
  };

  source.forEachChild(child => visit(child, false));
  return found;
}

test("专利域工具：注册表 annotate 声明数 == 运行期 patent 域工具数", () => {
  const declared = collectAnnotateDomains().filter(entry => entry.domain === "patent");
  const runtime = createBuiltinRegistry()
    .list()
    .filter(tool => tool.domain === "patent");

  assert.ok(declared.length > 0, '应能解析出 annotate(..., "patent") 调用点');
  assert.equal(
    runtime.length,
    declared.length,
    `patent 域工具数不一致：运行期 ${runtime.length} 个（${runtime.map(t => t.name).join(", ")}），` +
      `注册表 annotate 声明 ${declared.length} 处（第 ${declared.map(entry => entry.line).join(", ")} 行）。` +
      "差异通常意味着某个 creator 自标了别的 domain，从而静默覆盖注册表标注。",
  );
});

test("注册表所有工具的 domain 都在 ToolDomain 联合内", () => {
  const allowed = new Set(toolDomainUnion());
  assert.ok(allowed.has("patent"), "ToolDomain 解析失败（未取到 patent）");
  for (const tool of createBuiltinRegistry().list()) {
    assert.ok(
      tool.domain === undefined || allowed.has(tool.domain),
      `tool ${tool.name} 的 domain=${String(tool.domain)} 不在 ToolDomain 联合内（域过滤会静默失配）`,
    );
  }
});
