/**
 * 事件生产者/消费者矩阵生成器（阶段四 T8）。
 *
 * 解析 TS AST：从事件类型声明（discriminated union 的 type 字面量）提取事件
 * 名，从 emit/dispatch 调用点提取生产者，从 on/subscribe 调用点提取消费者，
 * 生成 docs/event-producer-consumer.md。--check 模式与已生成文件比对（CI 门禁，
 * 防事件改版漏订）。第一期覆盖 src/agent 与 src/gateway 两套事件语汇。
 *
 * 用法：
 *   pnpm tsx scripts/gen-event-matrix.ts           # 生成/覆盖文档
 *   pnpm tsx scripts/gen-event-matrix.ts --check   # 比对（CI）
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { exit } from "node:process";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT_PATH = join(REPO_ROOT, "docs", "event-producer-consumer.md");
const EVENT_TYPE_FILES = [
  "src/agent/protocol/events.ts",
  "src/gateway/protocol/types.ts",
  "src/gateway/protocol/frames.ts",
];

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTsFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** 从源码提取某类型名的 union 成员的 type 字面量。 */
function collectEventTypes(filePath: string, typeNames: string[]): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(typeNames);
  const events = new Set<string>();
  function visit(node: ts.Node): void {
    if (ts.isTypeAliasDeclaration(node) && names.has(node.name.text)) {
      const typeRefs: ts.Node[] = [node.type];
      while (typeRefs.length > 0) {
        const current = typeRefs.pop()!;
        if (ts.isTypeLiteralNode(current)) {
          for (const member of current.members) {
            if (ts.isPropertySignature(member) && member.name.getText(source) === "type") {
              const literal = member.type;
              if (literal && ts.isLiteralTypeNode(literal) && literal.literal.kind === ts.SyntaxKind.StringLiteral) {
                events.add((literal.literal as ts.StringLiteral).text);
              }
            }
          }
        } else if (ts.isUnionTypeNode(current)) {
          typeRefs.push(...current.types);
        } else if (ts.isParenthesizedTypeNode(current)) {
          typeRefs.push(current.type);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...events].sort();
}

type Site = { file: string; line: number };

function recordSite(
  sites: Map<string, Site[]>,
  eventName: string,
  file: string,
  source: ts.SourceFile,
  node: ts.Node,
): void {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const site = { file: relative(REPO_ROOT, file), line };
  const list = sites.get(eventName) ?? [];
  list.push(site);
  sites.set(eventName, list);
}

/** 从任意带 type 字面量的表达式里取事件名。 */
function eventNameFromExpression(node: ts.Node, source: ts.SourceFile): string | undefined {
  if (ts.isAsExpression(node) || ts.isParenthesizedExpression(node)) {
    return eventNameFromExpression(node.expression, source);
  }
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  return extractTypeLiteral(node, source);
}

/**
 * 扫描生产者/消费者调用点（启发式 v1，见计划 §7 风险 6）：
 * - 生产者：emit/dispatch/eventEmitter 调用、以及任意首参为含 type 字面量的
 *   对象表达式（含 yield { type }）——覆盖 AgentLoop 生成器事件泵；
 * - 消费者：首参为字符串字面量的 on/subscribe/emit 调用。
 */
function collectSites(dir: string, calleeNames: string[]): Map<string, Site[]> {
  const sites = new Map<string, Site[]>();
  const names = new Set(calleeNames);
  for (const file of listTsFiles(dir)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const calleeName = ts.isIdentifier(callee) ? callee.text : undefined;
        const first = node.arguments[0];
        if (first !== undefined) {
          if (ts.isObjectLiteralExpression(first)) {
            const eventName = eventNameFromExpression(first, source);
            if (eventName !== undefined) {
              recordSite(sites, eventName, file, source, node);
            }
          } else if (ts.isStringLiteral(first) && (calleeName === undefined || names.has(calleeName))) {
            recordSite(sites, first.text, file, source, node);
          }
        }
      } else if (ts.isYieldExpression(node) && node.expression !== undefined) {
        const eventName = eventNameFromExpression(node.expression, source);
        if (eventName !== undefined) {
          recordSite(sites, eventName, file, source, node);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return sites;
}

function extractTypeLiteral(node: ts.Node, source: ts.SourceFile): string | undefined {
  let value: string | undefined;
  function visit(n: ts.Node): void {
    if (value !== undefined) return;
    if (ts.isPropertyAssignment(n) && n.name.getText(source) === "type") {
      if (ts.isStringLiteral(n.initializer)) {
        value = n.initializer.text;
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(node);
  return value;
}

function renderMatrix(): string {
  const events: string[] = [];
  for (const file of EVENT_TYPE_FILES) {
    const full = join(REPO_ROOT, file);
    if (!existsSync(full)) continue;
    const typeName = file.includes("events.ts") ? "AgentEvent" : file.includes("frames") ? "WsFrame" : "GatewayEvent";
    events.push(...collectEventTypes(full, [typeName]));
  }
  const uniqueEvents = [...new Set(events)].sort();
  const producers = collectSites(join(REPO_ROOT, "src"), ["emit", "dispatch"]);
  const consumers = collectSites(join(REPO_ROOT, "src"), ["on", "subscribe"]);
  const lines: string[] = [
    "<!-- Generated by scripts/gen-event-matrix.ts - do not edit by hand. Run `pnpm gen:event-matrix` to regenerate. -->",
    "",
    "# 事件生产者/消费者矩阵（阶段四 T8）",
    "",
    "从源码生成：事件名取自 discriminated union 的 type 字面量；生产者为 emit/dispatch 调用点；",
    "消费者为 on/subscribe 调用点。改事件后运行 `pnpm gen:event-matrix --check`（CI 门禁）。",
    "",
    "| 事件 | 生产者 | 消费者 |",
    "| --- | --- | --- |",
  ];
  for (const event of uniqueEvents) {
    const ps = (producers.get(event) ?? []).map(s => s.file + ":" + s.line).join(", ") || "-";
    const cs = (consumers.get(event) ?? []).map(s => s.file + ":" + s.line).join(", ") || "-";
    lines.push("| " + event + " | " + ps + " | " + cs + " |");
  }
  return lines.join("\n") + "\n";
}

function main(): void {
  const check = process.argv.includes("--check");
  const rendered = renderMatrix();
  if (check) {
    if (!existsSync(OUTPUT_PATH)) {
      console.error("gen-event-matrix: " + OUTPUT_PATH + " missing; run `pnpm gen:event-matrix` first");
      exit(1);
    }
    const current = readFileSync(OUTPUT_PATH, "utf8");
    if (current !== rendered) {
      console.error("gen-event-matrix: event matrix is stale; run `pnpm gen:event-matrix` and commit the change");
      exit(1);
    }
    console.log("gen-event-matrix: fresh");
    return;
  }
  writeFileSync(OUTPUT_PATH, rendered, "utf8");
  console.log("gen-event-matrix: wrote " + OUTPUT_PATH);
}

main();
