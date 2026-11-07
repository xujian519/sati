/**
 * claim_lint —— 权要文本确定性校验（#830 M4）。
 *
 * 纯函数、零 LLM、零 I/O：输入权项文本数组，输出可解释的问题列表。
 * error 级阻断（由调用方决定是否回退 draft_claims），warning 级只透传。
 */

import {
  checkAntecedentConsistency,
  checkFunctionalLimitation,
  checkMultipleDependentBasis,
  checkNumberingContinuity,
  checkReferenceBasis,
  checkUncertainTerms,
} from "./rules.js";
import type { ClaimLintIssue, ClaimLintResult, ParsedClaim } from "./types.js";

export type { ClaimLintIssue, ClaimLintResult, ClaimLintRuleId, ClaimLintSeverity, ParsedClaim } from "./types.js";
export { subjectsCompatible } from "./rules.js";

const DEPENDENT_PATTERN = /根据权利要求\s*([0-9、,，和或及与\-~～至到\s]+?)\s*所述/;
const REFERENCE_CLAUSE_PATTERN = /根据权利要求\s*([0-9、,，和或及与\-~～至到\s]+?)\s*所述/;

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, char => String.fromCharCode(char.charCodeAt(0) - 0xfee0));
}

/** 解析引用编号，支持「1、2」「1或2」「1-3」「1至3」。 */
export function parseReferenceNumbers(clause: string): { numbers: number[]; alternative: boolean } {
  const normalized = toAsciiDigits(clause);
  const numbers = new Set<number>();
  const rangePattern = /(\d+)\s*(?:[-~～]|至|到)\s*(\d+)/g;
  let remaining = normalized;
  for (const match of normalized.matchAll(rangePattern)) {
    const start = Number(match[1]);
    const end = Number(match[2]);
    if (Number.isInteger(start) && Number.isInteger(end)) {
      for (let value = start; value <= end; value++) numbers.add(value);
    }
    remaining = remaining.replace(match[0], " ");
  }
  for (const match of remaining.matchAll(/\d+/g)) {
    numbers.add(Number(match[0]));
  }
  return {
    numbers: [...numbers].filter(value => Number.isInteger(value) && value > 0).sort((a, b) => a - b),
    alternative: /或|任一/.test(normalized),
  };
}

function extractSubject(text: string, dependent: boolean): string {
  if (dependent) {
    const match = text.match(/所述的(.+?)(?:[，,]|其特征在于|包括|包含|$)/);
    return match?.[1]?.trim() ?? "";
  }
  const head = text.split(/其特征在于|包括|包含/)[0] ?? "";
  return head.replace(/^一种/, "").trim();
}

function stripLeadingNumber(raw: string): string {
  return raw.replace(/^\s*[0-9０-９]+\s*[.、．,，:：]?\s*/, "");
}

/** 解析单个权项；未编号时用 `fallbackNo` 作为编号。 */
export function parseClaim(raw: string, fallbackNo: number): ParsedClaim {
  const normalized = toAsciiDigits(raw);
  const numbered = normalized.match(/^\s*(\d+)\s*[.、．,，:：]?/);
  const claimNo = numbered === null ? fallbackNo : Number(numbered[1]);
  const text = stripLeadingNumber(normalized);
  const dependency = text.match(DEPENDENT_PATTERN);
  const independent = dependency === null && !/根据权利要求/.test(text);
  const referenceClause = text.match(REFERENCE_CLAUSE_PATTERN)?.[1] ?? "";
  const parsedReference = parseReferenceNumbers(referenceClause);
  return {
    claimNo,
    text,
    subject: extractSubject(text, !independent),
    independent,
    dependsOn: independent ? [] : parsedReference.numbers,
    alternativeReference: parsedReference.alternative,
  };
}

function sortIssues(issues: ClaimLintIssue[]): ClaimLintIssue[] {
  return issues.sort((a, b) => {
    const left = a.claimNo ?? Number.MAX_SAFE_INTEGER;
    const right = b.claimNo ?? Number.MAX_SAFE_INTEGER;
    if (left !== right) return left - right;
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    return a.rule.localeCompare(b.rule);
  });
}

/** 校验一组权项文本（数组顺序即权项顺序）。 */
export function lintClaims(rawClaims: readonly string[]): ClaimLintResult {
  const claims = rawClaims.map((raw, index) => parseClaim(raw, index + 1));
  const byNumber = new Map<number, ParsedClaim>();
  for (const claim of claims) {
    if (!byNumber.has(claim.claimNo)) byNumber.set(claim.claimNo, claim);
  }

  const issues = sortIssues([
    ...checkUncertainTerms(claims),
    ...checkReferenceBasis(claims, byNumber),
    ...checkMultipleDependentBasis(claims, byNumber),
    ...checkAntecedentConsistency(claims, byNumber),
    ...checkFunctionalLimitation(claims),
    ...checkNumberingContinuity(claims),
  ]);
  const errors = issues.filter(issue => issue.severity === "error");
  const warnings = issues.filter(issue => issue.severity === "warning");
  return { issues, errors, warnings, passed: errors.length === 0 };
}

/** 从整段权要文本（按行首编号切分）校验；无编号时退回按行切分。 */
export function lintClaimText(text: string): ClaimLintResult {
  const numbered = text
    .split(/(?=^\s*[0-9０-９]+\s*[.、．])/m)
    .map(chunk => chunk.trim())
    .filter(Boolean);
  const chunks =
    numbered.length > 1
      ? numbered
      : text
          .split(/\n{2,}/)
          .map(chunk => chunk.trim())
          .filter(Boolean);
  return lintClaims(chunks);
}
