/**
 * 事件生产者/消费者矩阵生成器（阶段四 T8）。
 *
 * 解析 TS AST：从事件类型声明（discriminated union 的 type 字面量）提取事件
 * 名，从 emit/dispatch 调用点提取生产者，从 on/subscribe 调用点提取消费者，
 * 生成 docs/event-producer-consumer.md。--check 模式与已生成文件比对（CI 门禁，
 * 防事件改版漏订）。第一期覆盖 src/agent 与 src/gateway 两套事件语汇；
 * M4（Task 11）追加 src/agent/team 的 TeamEvent 语汇（task_retried 等变体入矩阵）。
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
  // M4（Task 11）：TeamEvent 变体（task_retried 等）入矩阵——emit 调用点（scheduler/
  // 工具层）在 collectSites 已扫描，缺的是声明语汇解析；team_event 网关帧行不变。
  "src/agent/team/protocol/events.ts",
];

/** 事件名 → 语汇名（AgentEvent / GatewayEvent / WsFrame）。 */
type EventVocabMap = Map<string, string[]>;

/**
 * 事件流消费入口白名单：for-await-of 循环消费对应语汇流的**全部**事件。
 * submit → AgentSession.submit（AsyncIterable<AgentEvent>）；
 * submitTurn → Gateway.submitTurn（AsyncIterable<GatewayEvent>）。
 */
const STREAM_CONSUMER_ENTRIES: ReadonlyArray<{ callee: string; vocab: string }> = [
  { callee: "submit", vocab: "AgentEvent" },
  { callee: "submitTurn", vocab: "GatewayEvent" },
];

/** 流消费点在主体表格中折叠的站点数上限；超限折叠为「{callee} 流 ×N」并在附录详列。 */
const MAX_INLINE_STREAM_SITES = 4;

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

/**
 * 从源码提取某类型名的 union 成员的 type 字面量（事件名 → 语汇名数组）。
 * 支持 IntersectionTypeNode（如 `GatewayEvent = Metadata & (union)`——此前仅处理
 * Union/Parenthesized，GatewayEvent 语汇整族漏收），成员逐层解包后按 TypeLiteral
 * 的 `type` 属性 StringLiteral 收集。
 */
function collectEventTypes(filePath: string, typeNames: string[]): EventVocabMap {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  const names = new Set(typeNames);
  const events = new Map<string, string[]>();
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
                const name = (literal.literal as ts.StringLiteral).text;
                const vocabs = events.get(name) ?? [];
                if (!vocabs.includes(node.name.text)) vocabs.push(node.name.text);
                events.set(name, vocabs);
              }
            }
          }
        } else if (ts.isUnionTypeNode(current)) {
          typeRefs.push(...current.types);
        } else if (ts.isIntersectionTypeNode(current)) {
          typeRefs.push(...current.types);
        } else if (ts.isParenthesizedTypeNode(current)) {
          typeRefs.push(current.type);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return events;
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

/** 扫描角色：producer 收集 emit/dispatch/对象字面量/yield；consumer 仅收集 on/subscribe。 */
type CollectMode = "producer" | "consumer";

/** 解析调用目标名：标识符（emit）、属性访问（emitter.emit → emit）与元素访问（emitter["emit"] → emit）。 */
function calleeNameOf(callee: ts.Expression): string | undefined {
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isElementAccessExpression(callee)) {
    const key = callee.argumentExpression;
    return ts.isStringLiteral(key) ? key.text : undefined;
  }
  return undefined;
}

/**
 * 扫描生产者/消费者调用点（启发式 v1，见计划 §7 风险 6）：
 * - 生产者：emit/dispatch 调用、以及任意含 type 字面量的对象表达式
 *   参数（首参优先，M4 Task 11 起扩展到第二参——团队 emit 为
 *   emit(captainSessionKey, event) 两参形态；含 yield { type }）——
 *   覆盖 AgentLoop 生成器事件泵与 TeamEvent 广播；
 * - 消费者：首参为字符串字面量的 on/subscribe 调用。
 *
 * 去重修正：消费者扫描不再把对象字面量首参与 yield 记入（否则同一调用点会
 * 同时出现在生产/消费两列——同源重复）；字符串字面量分支要求 callee 名落在
 * 目标集内（属性访问经 calleeNameOf 归一，避免 emitter.on("x") 被误记为生产者）。
 */
function collectSites(dir: string, calleeNames: string[], mode: CollectMode): Map<string, Site[]> {
  const sites = new Map<string, Site[]>();
  const names = new Set(calleeNames);
  for (const file of listTsFiles(dir)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const calleeName = calleeNameOf(node.expression);
        // 对象字面量参数：首参保持既有行为（不检查 callee 名——yield/emit 首参
        // 形态兼容）；第二参（emit(captain, event) 形态——团队 TeamEvent 广播、
        // emitForSession(sessionKey, event)）要求 callee 落在事件发射器集合内，
        // 防止 createTurnResult(input, { type: "error" }) 之类普通调用被误记为生产点。
        const first = node.arguments[0];
        const firstIsObject =
          first !== undefined &&
          (ts.isObjectLiteralExpression(first) ||
            (ts.isAsExpression(first) && ts.isObjectLiteralExpression(first.expression)));
        const second = node.arguments[1];
        const secondIsObject =
          second !== undefined &&
          (ts.isObjectLiteralExpression(second) ||
            (ts.isAsExpression(second) && ts.isObjectLiteralExpression(second.expression)));
        const stringArg = node.arguments[0];
        let recorded = false;
        if (firstIsObject && mode === "producer") {
          const eventName = eventNameFromExpression(first!, source);
          if (eventName !== undefined) {
            recordSite(sites, eventName, file, source, node);
            recorded = true;
          }
        } else if (secondIsObject && calleeName !== undefined && names.has(calleeName) && mode === "producer") {
          const eventName = eventNameFromExpression(second!, source);
          if (eventName !== undefined) {
            recordSite(sites, eventName, file, source, node);
            recorded = true;
          }
        }
        // 字符串事件名调用（emit("event", payload) 形态）——首参为对象字面量时
        // 不检查（既有语义）；第二参对象无 type 字段时回退（emitAgentEvent("x", {..})）。
        if (
          !recorded &&
          stringArg !== undefined &&
          ts.isStringLiteral(stringArg) &&
          calleeName !== undefined &&
          names.has(calleeName)
        ) {
          recordSite(sites, stringArg.text, file, source, node);
        }
      } else if (mode === "producer" && ts.isYieldExpression(node) && node.expression !== undefined) {
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

/**
 * 事件流消费点：`for await (const x of <callee>(...))` 循环，callee 名落在
 * 流入口白名单（submit / submitTurn）时，把该站点记入对应语汇的流消费集合
 * （该循环消费该语汇流的**全部**事件，无法归因到单个事件名）。
 */
function collectStreamConsumers(dir: string): Map<string, Site[]> {
  const sites = new Map<string, Site[]>();
  for (const file of listTsFiles(dir)) {
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node): void {
      if (ts.isForOfStatement(node) && node.awaitModifier !== undefined && ts.isCallExpression(node.expression)) {
        const calleeName = calleeNameOf(node.expression.expression);
        const entry = STREAM_CONSUMER_ENTRIES.find(e => e.callee === calleeName);
        if (entry !== undefined) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
          const site = { file: relative(REPO_ROOT, file), line };
          const list = sites.get(entry.vocab) ?? [];
          list.push(site);
          sites.set(entry.vocab, list);
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

/** 站点去重（同一 file:line 只出现一次）。 */
function dedupeSites(sites: Site[]): Site[] {
  const seen = new Set<string>();
  const out: Site[] = [];
  for (const site of sites) {
    const key = site.file + ":" + site.line;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(site);
    }
  }
  return out;
}

function renderMatrix(): string {
  const eventVocabs = new Map<string, string[]>();
  for (const file of EVENT_TYPE_FILES) {
    const full = join(REPO_ROOT, file);
    if (!existsSync(full)) continue;
    // 路径区分：team/protocol/events.ts 的 alias 名为 TeamEvent（非 AgentEvent）。
    const typeName = file.includes("team/")
      ? "TeamEvent"
      : file.includes("events.ts")
        ? "AgentEvent"
        : file.includes("frames")
          ? "WsFrame"
          : "GatewayEvent";
    for (const [name, vocabs] of collectEventTypes(full, [typeName])) {
      const existing = eventVocabs.get(name) ?? [];
      eventVocabs.set(name, [...new Set([...existing, ...vocabs])]);
    }
  }
  const uniqueEvents = [...eventVocabs.keys()].sort();
  // emit-like 调用名集合：除 emit/dispatch 外含 emitAgentEvent/emitEvent
  // （属性访问经 calleeNameOf 归一后按名匹配，补回旧启发式 calleeName===undefined
  // 曾覆盖的这两类字符串事件名调用点）；emitForSession 为 M4（Task 11）追加——
  // emit(captain, event)/emitForSession(sessionKey, event) 第二参对象字面量形态
  // 的 TeamEvent 广播（scheduler/网关链路）须入生产者矩阵。
  const producers = collectSites(
    join(REPO_ROOT, "src"),
    ["emit", "dispatch", "emitAgentEvent", "emitEvent", "emitForSession"],
    "producer",
  );
  const consumers = collectSites(join(REPO_ROOT, "src"), ["on", "subscribe"], "consumer");
  const streamConsumers = collectStreamConsumers(join(REPO_ROOT, "src"));

  const lines: string[] = [
    "<!-- Generated by scripts/gen-event-matrix.ts - do not edit by hand. Run `pnpm gen:event-matrix` to regenerate. -->",
    "",
    "# 事件生产者/消费者矩阵（阶段四 T8）",
    "",
    "从源码生成：事件名取自 discriminated union 的 type 字面量（含交叉类型如 GatewayEvent，见附录）；生产者为",
    "emit/dispatch/emitAgentEvent/emitEvent 字符串事件名调用点、对象字面量首参调用点与 yield { type } 泵；",
    "消费者为 on/subscribe 字符串订阅调用点 + 事件流消费点（for-await 语汇流，折叠为「{callee} 流 ×N」，明细见附录）。",
    "改事件后运行 `pnpm gen:event-matrix --check`（CI 门禁）。",
    "",
    "| 事件 | 生产者 | 消费者 |",
    "| --- | --- | --- |",
  ];
  for (const event of uniqueEvents) {
    const ps = (producers.get(event) ?? []).map(s => s.file + ":" + s.line).join(", ") || "-";
    const vocabs = eventVocabs.get(event) ?? [];
    const exact = consumers.get(event) ?? [];
    const csParts: string[] = exact.map(s => s.file + ":" + s.line);
    for (const entry of STREAM_CONSUMER_ENTRIES) {
      if (!vocabs.includes(entry.vocab)) continue;
      const sites = dedupeSites(streamConsumers.get(entry.vocab) ?? []);
      if (sites.length === 0) continue;
      if (sites.length <= MAX_INLINE_STREAM_SITES) {
        csParts.push(...sites.map(s => s.file + ":" + s.line));
      } else {
        csParts.push(entry.callee + " 流 ×" + sites.length);
      }
    }
    const cs = csParts.length > 0 ? csParts.join(", ") : "-";
    lines.push("| " + event + " | " + ps + " | " + cs + " |");
  }

  // 附录：事件流消费点明细（流入口白名单的 for-await 站点）。
  const anyStream = STREAM_CONSUMER_ENTRIES.some(e => (streamConsumers.get(e.vocab) ?? []).length > 0);
  if (anyStream) {
    lines.push(
      "",
      "### 事件流消费点（for-await 语汇流）",
      "",
      "以下站点以 `for await` 消费对应语汇流的**全部**事件（流入口白名单：`submit` → AgentEvent，",
      "`submitTurn` → GatewayEvent）。主体表格的消费者列把这类消费折叠为「{callee} 流 ×N」。",
      "",
      "| 流入口 | 语汇 | 消费站点 |",
      "| --- | --- | --- |",
    );
    for (const entry of STREAM_CONSUMER_ENTRIES) {
      const sites = dedupeSites(streamConsumers.get(entry.vocab) ?? []);
      if (sites.length === 0) continue;
      const rendered = sites.map(s => s.file + ":" + s.line).join(", ");
      lines.push("| " + entry.callee + " | " + entry.vocab + " | " + rendered + " |");
    }
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
