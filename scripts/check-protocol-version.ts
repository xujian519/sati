/**
 * 网关协议版本台账门禁（issue #362 / TD-GATEWAY-N01）。
 *
 * 背景：协议方法清单长期被视为「同一事实的三份手写副本」。核码结论是三者门禁强度
 * 并不一致——`METHOD_PARAM_GUARDS` 早已由 `satisfies Record<WsGatewayMethod, ParamSpec>`
 * 编译期把关，真正**完全无门禁**的只有旧 `version.ts` 的散文变更表，而它已经漂移两次：
 *   - `knowledge_capabilities`（2026-08-06 引入，实际属 1.1）
 *   - `kanban_reorder_columns`（2026-08-26 引入，实际属 1.5）
 * 两者都在本门禁落地时才被点名。
 *
 * 判据的两个**独立生产点**（避免同源对拍恒真）：union 成员从 `frames.ts` 的 AST
 * 重新提取（声明侧），台账与守卫表从模块值读取（数据侧）。
 *
 * 用法：
 *   pnpm check:protocol-version
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { exit } from "node:process";
import ts from "typescript";
import {
  PROTOCOL_METHOD_VERSION,
  PROTOCOL_RELEASES,
  SATI_GATEWAY_PROTOCOL_VERSION,
  protocolLedgerIssues,
} from "../src/gateway/protocol/version.js";
import { METHOD_PARAM_GUARDS } from "../src/gateway/server/methodGuards.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FRAMES_PATH = resolve(REPO_ROOT, "src", "gateway", "protocol", "frames.ts");
const METHOD_UNION_NAME = "WsGatewayMethod";

/** 从声明的 AST 提取字符串字面量联合成员；解析不到返回 null（而非空集）。 */
function collectUnionMembers(filePath: string, typeName: string): string[] | null {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const members: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName && ts.isUnionTypeNode(node.type)) {
      for (const type of node.type.types) {
        if (ts.isLiteralTypeNode(type) && ts.isStringLiteral(type.literal)) {
          members.push(type.literal.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return members.length > 0 ? members : null;
}

function diff(actual: readonly string[], expected: readonly string[]): string[] {
  const expectedSet = new Set(expected);
  return actual.filter(item => !expectedSet.has(item));
}

function main(): void {
  const problems: string[] = [];

  const unionMembers = collectUnionMembers(FRAMES_PATH, METHOD_UNION_NAME);
  if (unionMembers === null) {
    // 解析失败必须显式报错：静默的空集会让整个门禁变成恒真。
    console.error(
      `check-protocol-version: 未能从 ${FRAMES_PATH} 解析出 ${METHOD_UNION_NAME} 的联合成员` +
        "（类型改名或写法变更？门禁拒绝在解析不到时放行）",
    );
    exit(1);
  }

  const ledgerMethods = Object.keys(PROTOCOL_METHOD_VERSION);
  if (ledgerMethods.length === 0) {
    console.error("check-protocol-version: PROTOCOL_METHOD_VERSION 为空");
    exit(1);
  }

  for (const method of diff(unionMembers, ledgerMethods)) {
    problems.push(`方法 ${method} 在 ${METHOD_UNION_NAME} 中但未登记到 PROTOCOL_METHOD_VERSION`);
  }
  for (const method of diff(ledgerMethods, unionMembers)) {
    problems.push(`PROTOCOL_METHOD_VERSION 登记了 ${method}，但它不在 ${METHOD_UNION_NAME} 中`);
  }
  for (const method of diff(unionMembers, Object.keys(METHOD_PARAM_GUARDS))) {
    problems.push(`方法 ${method} 未登记到 METHOD_PARAM_GUARDS（参数守卫表）`);
  }

  for (const issue of protocolLedgerIssues({
    releases: PROTOCOL_RELEASES,
    methodVersions: PROTOCOL_METHOD_VERSION,
    currentVersion: SATI_GATEWAY_PROTOCOL_VERSION,
  })) {
    problems.push(`[${issue.code}] ${issue.detail}`);
  }

  if (problems.length > 0) {
    console.error(`check-protocol-version: 协议方法台账不一致（${problems.length} 项）`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(
      "新增/改名 gateway 方法时：同步 frames.ts union、methodGuards.ts 守卫表、" +
        "version.ts 的 PROTOCOL_METHOD_VERSION，并（如为新增方法）在 PROTOCOL_RELEASES 追加一条 MINOR。",
    );
    exit(1);
  }

  console.log(
    `check-protocol-version: fresh（${unionMembers.length} 方法，协议 ${SATI_GATEWAY_PROTOCOL_VERSION}，` +
      `${PROTOCOL_RELEASES.length} 个版本）`,
  );
}

main();
