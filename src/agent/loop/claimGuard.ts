/**
 * claimGuard — 声称-行动守卫（W3，借鉴 GenOffice verifyResponse）。
 *
 * 在模型给出无工具调用的收尾文本前，检查「文本声称 vs 本 run 实际执行成功
 * 的工具」：出现验证类声称（已验证/verified/测试通过…）但没有任何支撑工具
 * 成功执行时，返回纠正指令强制再跑一轮（每 run 至多一次，见
 * TurnRuntimeState.hasAttemptedClaimGuardRetry）。模型可补做支撑动作或改口。
 *
 * 与 registerLeak（src/context/workspace/registerLeak.ts）的分工：registerLeak
 * 是输出后的报告型检测（ship 门用），本模块是收尾前的有界纠正；正则语义
 * 对齐但自包含，保持 loop 模块零 context 依赖可独立测试。
 */

/**
 * 声称短语模式（中英双语，语义对齐 registerLeak CLAIM_RE）。
 *
 * 否定式排除：\b 词边界排除 unverified/uncontested 等形态包含（contested
 * 含 tested 子串）；(?<!not )/(?<!yet ) 排除英文短语否定；(?<!未) 排除
 * 「未经验证/未经测试/未经证明」类诚实披露（尚无/待验证类短语本身不含
 * 已列短语，天然不命中）。残留风险：yet to be verified 等罕见句式仍命中。
 */
const CLAIM_RE =
  /(?<!not )(?<!yet )\b(?:verified|confirmed|validated|tested|proven)\b|(?<!未)(?:经验证|经测试|经证明)|已验证|已经验证|验证通过|已确认|确认无误|已经测试|测试通过|已经证明/i;

/** fenced code block 行（声称在代码块内不视为对用户的声称）。 */
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

/**
 * 支撑「验证类声称」的工具名集合：本 run 内任一成功执行即视为声称有支撑。
 * 未列出的工具不构成支撑（如纯检索不支撑「已验证」）。
 */
export const CLAIM_SUPPORT_TOOLS: ReadonlySet<string> = new Set([
  "rule_check",
  "patent_worker_validate",
  "validate_specification",
  "evaluate_evidence",
  "patent_eval",
  "claim_chart_build",
]);

export type ClaimGuardVerdict = { kind: "pass" } | { kind: "correction"; claim: string; prompt: string };

/** 找到首个无支撑声称短语（fenced code 行跳过）；无则返回 undefined。 */
function findUncoveredClaim(lines: string[]): string | undefined {
  let inFence = false;
  for (const line of lines) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = CLAIM_RE.exec(line);
    if (match !== null) return match[0];
  }
  return undefined;
}

/**
 * 评估收尾文本的声称-行动一致性。
 *
 * @param finalText - 模型收尾文本。
 * @param succeededTools - 本 run 内成功执行（非 error 结果）的工具名列表。
 * @returns pass 或带纠正指令的 correction。
 */
export function evaluateClaimGuard(finalText: string, succeededTools: readonly string[]): ClaimGuardVerdict {
  const claim = findUncoveredClaim(finalText.split(/\r?\n/));
  if (claim === undefined) return { kind: "pass" };
  const supported = succeededTools.some(name => CLAIM_SUPPORT_TOOLS.has(name));
  if (supported) return { kind: "pass" };
  return { kind: "correction", claim, prompt: buildClaimGuardPrompt(claim) };
}

/** 构建纠正指令（transient 注入，模型可补做支撑动作或改口）。 */
export function buildClaimGuardPrompt(claim: string): string {
  return [
    `Your previous response claims "${claim}", but no verification tool succeeded in this run.`,
    "Either perform the supporting action now (rule_check / validation tools), or reword the claim to state exactly what was done.",
    "Do not repeat the same claim without support.",
  ].join(" ");
}
