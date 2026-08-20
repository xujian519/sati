/**
 * 专利域案例目录约定（单一事实源）。
 *
 * 此前 worker-contract 的 `data/cases/{caseId}/outputs` 与 patentWorkflowTool 的
 * `data/cases/{caseId}/workflow-runs` 两处各自维护字面量，靠注释"对齐"——
 * 本模块统一推导，避免路径约定漂移。
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

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

/**
 * 决策链库目录（provenance.db 所在目录）：三态解析与工具层 resolveWorkflowRunsDir
 * 同构（绝对路径 → `<caseId>/provenance`；含分隔符相对路径 → `<cwd>/<caseId>/provenance`；
 * 纯 id → `<cwd>/data/cases/<caseId>/provenance`）。打开前调用方需 mkdir（openKnowledgeDb 不建父目录）。
 */
export function caseProvenanceDir(caseId: string, cwd: string): string {
  if (isAbsolute(caseId)) return join(caseId, "provenance");
  if (caseId.includes("/") || caseId.includes("\\")) return join(cwd, caseId, "provenance");
  return join(cwd, CASE_ROOT_REL, caseId, "provenance");
}

/** 全局审批审计库目录（`~/.sati/provenance`，`SATI_PROVENANCE_DIR` 覆盖；与 knowledge 的 ~/.sati 约定一致）。 */
export function provenanceAuditDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.SATI_PROVENANCE_DIR ?? join(homedir(), ".sati", "provenance");
}
