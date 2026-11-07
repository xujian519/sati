/** claim_lint 规则标识（稳定字符串，供评测与日志聚合）。 */
export type ClaimLintRuleId =
  | "uncertain-term"
  | "reference-basis"
  | "multiple-dependent-basis"
  | "antecedent-consistency"
  | "functional-limitation"
  | "numbering-continuity";

export type ClaimLintSeverity = "error" | "warning";

export interface ClaimLintIssue {
  rule: ClaimLintRuleId;
  severity: ClaimLintSeverity;
  /** 1 基权项号；编号本身缺失时为 `undefined`。 */
  claimNo?: number;
  message: string;
  hint: string;
}

export interface ClaimLintResult {
  issues: ClaimLintIssue[];
  errors: ClaimLintIssue[];
  warnings: ClaimLintIssue[];
  /** 无 error 即通过；warning 不阻断（降级可见，见 #830 M4）。 */
  passed: boolean;
}

/** 解析后的单个权项，供规则共享，避免每条规则重复解析。 */
export interface ParsedClaim {
  /** 1 基权项号；文本未编号时按数组下标推断。 */
  claimNo: number;
  text: string;
  /** 主题名称（"一种…"/"根据权利要求…所述的…" 中的主题）。 */
  subject: string;
  independent: boolean;
  dependsOn: number[];
  /** 引用文本是否用"或"择一表述（多项引用的合规形态）。 */
  alternativeReference: boolean;
}
