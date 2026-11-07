import type { ClaimLintIssue, ParsedClaim } from "./types.js";

/** 规则 1：不确定用语。按 #830 M4 的固定词表，不做同义扩展。 */
const UNCERTAIN_TERM_PATTERNS: ReadonlyArray<{ pattern: RegExp; term: string }> = [
  { pattern: /(?<![相平高对同])等(?!于)/, term: "等" },
  { pattern: /约为|约(?=\s*\d)/, term: "约" },
  { pattern: /适当/, term: "适当" },
  { pattern: /可以/, term: "可以" },
];

/** 规则 5 使用的结构/步骤特征词；出现任一即不视为"纯功能性限定"。 */
const STRUCTURAL_MARKERS = /包括|包含|具有|设有|设置有|连接|安装|固定|步骤|获取|发送|接收|生成|确定|存储|输出|输入/;

export function checkUncertainTerms(claims: readonly ParsedClaim[]): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  for (const claim of claims) {
    const hits = UNCERTAIN_TERM_PATTERNS.filter(({ pattern }) => pattern.test(claim.text));
    for (const hit of hits) {
      issues.push({
        rule: "uncertain-term",
        severity: "error",
        claimNo: claim.claimNo,
        message: `权利要求 ${claim.claimNo} 含不确定用语「${hit.term}」，保护范围不清楚。`,
        hint: "改为可量化的限定，或删除该用语后重新表述。",
      });
    }
  }
  return issues;
}

export function checkReferenceBasis(
  claims: readonly ParsedClaim[],
  byNumber: ReadonlyMap<number, ParsedClaim>,
): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  for (const claim of claims) {
    if (claim.independent) continue;
    if (claim.dependsOn.length === 0) {
      issues.push({
        rule: "reference-basis",
        severity: "error",
        claimNo: claim.claimNo,
        message: `权利要求 ${claim.claimNo} 无法解析引用的在前权利要求编号。`,
        hint: "写成「根据权利要求N所述的…」，N 为阿拉伯数字。",
      });
      continue;
    }
    for (const target of claim.dependsOn) {
      if (target >= claim.claimNo || !byNumber.has(target)) {
        issues.push({
          rule: "reference-basis",
          severity: "error",
          claimNo: claim.claimNo,
          message: `权利要求 ${claim.claimNo} 引用了不存在的在前权利要求 ${target}。`,
          hint: `只能引用编号小于 ${claim.claimNo} 且已存在的权项。`,
        });
      }
    }
  }
  return issues;
}

export function checkMultipleDependentBasis(
  claims: readonly ParsedClaim[],
  byNumber: ReadonlyMap<number, ParsedClaim>,
): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  for (const claim of claims) {
    if (claim.independent) continue;
    if (claim.dependsOn.length > 1 && !claim.alternativeReference) {
      issues.push({
        rule: "multiple-dependent-basis",
        severity: "error",
        claimNo: claim.claimNo,
        message: `权利要求 ${claim.claimNo} 引用多项在前权利要求，但未使用择一方式。`,
        hint: "多项引用须写成「根据权利要求1或2所述的…」。",
      });
    }
    for (const target of claim.dependsOn) {
      const base = byNumber.get(target);
      if (base !== undefined && !base.independent && base.dependsOn.length > 1) {
        issues.push({
          rule: "multiple-dependent-basis",
          severity: "error",
          claimNo: claim.claimNo,
          message: `权利要求 ${claim.claimNo} 以多项从属权利要求 ${target} 为基础。`,
          hint: "多项从属权利要求不得作为另一项多项从属权利要求的基础。",
        });
      }
    }
  }
  return issues;
}

export function checkAntecedentConsistency(
  claims: readonly ParsedClaim[],
  byNumber: ReadonlyMap<number, ParsedClaim>,
): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  for (const claim of claims) {
    if (claim.independent || claim.subject.length === 0) continue;
    const targets = claim.dependsOn.map(target => byNumber.get(target)).filter(base => base !== undefined);
    for (const base of targets) {
      if (base.subject.length === 0) continue;
      if (!subjectsCompatible(claim.subject, base.subject)) {
        issues.push({
          rule: "antecedent-consistency",
          severity: "warning",
          claimNo: claim.claimNo,
          message: `权利要求 ${claim.claimNo} 的主题「${claim.subject}」与被引用权项 ${base.claimNo} 的「${base.subject}」不一致。`,
          hint: "从权前序主题应与被引用权项保持一致。",
        });
      }
    }
  }
  return issues;
}

export function checkFunctionalLimitation(claims: readonly ParsedClaim[]): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  for (const claim of claims) {
    if (!claim.independent) continue;
    const functional = /用于|被配置为|配置为|能够|适用于/.test(claim.text);
    if (!functional) continue;
    if (STRUCTURAL_MARKERS.test(claim.text)) continue;
    issues.push({
      rule: "functional-limitation",
      severity: "warning",
      claimNo: claim.claimNo,
      message: `权利要求 ${claim.claimNo} 疑似纯功能性限定，缺少结构或步骤特征。`,
      hint: "补充实现该功能的结构/步骤，并在说明书中给出对应实施方式。",
    });
  }
  return issues;
}

export function checkNumberingContinuity(claims: readonly ParsedClaim[]): ClaimLintIssue[] {
  const issues: ClaimLintIssue[] = [];
  const seen = new Set<number>();
  for (const [index, claim] of claims.entries()) {
    const expected = index + 1;
    if (claim.claimNo !== expected) {
      issues.push({
        rule: "numbering-continuity",
        severity: "error",
        claimNo: claim.claimNo,
        message: `第 ${expected} 个权项的编号为 ${claim.claimNo}，编号不连续。`,
        hint: "权项编号须从 1 开始连续递增。",
      });
    }
    if (seen.has(claim.claimNo)) {
      issues.push({
        rule: "numbering-continuity",
        severity: "error",
        claimNo: claim.claimNo,
        message: `权利要求编号 ${claim.claimNo} 重复。`,
        hint: "每个权项编号必须唯一。",
      });
    }
    seen.add(claim.claimNo);
  }
  return issues;
}

/** 主题一致性：容忍「一种」「所述」等前缀差异，不做同义改写。 */
export function subjectsCompatible(a: string, b: string): boolean {
  const normalize = (value: string) => value.replace(/一种|所述|的|，|,|\s/g, "");
  const left = normalize(a);
  const right = normalize(b);
  if (left.length === 0 || right.length === 0) return true;
  return left === right || left.endsWith(right) || right.endsWith(left);
}
