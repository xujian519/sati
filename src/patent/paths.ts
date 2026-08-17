/**
 * 专利域案例目录约定（单一事实源）。
 *
 * 此前 worker-contract 的 `data/cases/{caseId}/outputs` 与 patentWorkflowTool 的
 * `data/cases/{caseId}/workflow-runs` 两处各自维护字面量，靠注释"对齐"——
 * 本模块统一推导，避免路径约定漂移。
 */

/** 案例根目录（相对 cwd）。 */
export const CASE_ROOT_REL = "data/cases";

/** worker 输出子目录名。 */
export const CASE_OUTPUTS_REL = "outputs";

/** 工作流运行记录子目录名。 */
export const CASE_WORKFLOW_RUNS_REL = "workflow-runs";

/** 创造性分析人工反馈文件名（HITL 反馈回流，P2-4）。 */
export const CASE_INVENTIVENESS_FEEDBACK_FILE = "inventiveness-feedback.jsonl";

/** `<root>/data/cases/<caseId>/outputs`（worker 输出目录约定，caseId 可含 {caseId} 占位）。 */
export function caseOutputsDir(caseId: string): string {
  return `${CASE_ROOT_REL}/${caseId}/${CASE_OUTPUTS_REL}`;
}

/** `<root>/data/cases/<caseId>/workflow-runs`（工作流运行记录目录约定）。 */
export function caseWorkflowRunsDir(caseId: string): string {
  return `${CASE_ROOT_REL}/${caseId}/${CASE_WORKFLOW_RUNS_REL}`;
}

/** `<root>/data/cases/<caseId>/inventiveness-feedback.jsonl`（创造性人工反馈回流文件）。 */
export function caseInventivenessFeedbackPath(caseId: string): string {
  return `${CASE_ROOT_REL}/${caseId}/${CASE_INVENTIVENESS_FEEDBACK_FILE}`;
}
