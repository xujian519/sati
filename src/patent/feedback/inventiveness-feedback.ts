/**
 * src/patent/feedback/inventiveness-feedback — 创造性结论人工反馈回流（P2-4）。
 *
 * HITL 审批驳回/修改（ApprovalRecord.verdict = rejected/modified）时，把原文与
 * 人工反馈追加到 `data/cases/<caseId>/inventiveness-feedback.jsonl`（路径约定见
 * paths.ts）；后续分析同 case 时读取历史反馈，注入 conclude 提示（仅提示，不强制）。
 *
 * 纯函数 + 显式文件路径注入（不依赖全局状态）；文件不存在时 load 返回空数组。
 */

import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { dirname, join } from "node:path";
import { CASE_WORKFLOW_RUNS_REL } from "../paths.js";
import type { ApprovalVerdict } from "../approval.js";

/** 反馈回流记录（ApprovalRecord 子集 + caseId 定位）。 */
export type InventivenessFeedbackRecord = {
  caseId: string;
  /** 触发审批的结论原文摘录（截断至 500 字符，对齐 ApprovalRecord.originalOutputPreview）。 */
  originalOutputPreview: string;
  verdict: Extract<ApprovalVerdict, "modified" | "rejected">;
  /** 人工反馈理由（rejected）/ 修改说明（modified）。 */
  feedback?: string;
  /** 修改后的输出（verdict=modified 时）。 */
  modifiedOutput?: string;
  /** 审批触发词/规则 id（ApprovalRecord.triggerKeyword，溯源用）：绑定按 session 近似归属，
   * 同 session 内非创造性链路的审批也会命中绑定，溯源字段供事后甄别/过滤。 */
  trigger?: string;
  decidedAt: string;
};

/** 追加一条反馈记录（JSONL；目录不存在时创建，写失败抛错由调用方决定降级）。 */
export async function appendInventivenessFeedback(
  filePath: string,
  record: InventivenessFeedbackRecord,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(record) + "\n", { encoding: "utf8", flag: "a" });
}

/** 读取全部反馈记录（文件不存在返回空数组；坏行跳过）。 */
export async function loadInventivenessFeedback(filePath: string): Promise<InventivenessFeedbackRecord[]> {
  if (!existsSync(filePath)) return [];
  const text = await readFile(filePath, "utf8");
  const records: InventivenessFeedbackRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line) as InventivenessFeedbackRecord);
    } catch {
      // 坏行跳过（追加写并发时可能读到半行）。
    }
  }
  return records;
}

/** 汇总反馈为 conclude 提示文本（无记录返回空串；最多汇总 5 条）。 */
export function summarizeInventivenessFeedback(records: readonly InventivenessFeedbackRecord[]): string {
  if (records.length === 0) return "";
  const lines = records.slice(-5).map((r, i) => {
    const feedback = r.feedback !== undefined && r.feedback.length > 0 ? `反馈: ${r.feedback}` : "（无文字反馈）";
    return `${i + 1}. ${r.decidedAt} ${r.verdict} — ${feedback}`;
  });
  return `【历史人工反馈（仅供参考，不强制采纳）】\n${lines.join("\n")}`;
}

/**
 * session→case 绑定（P2-4 写侧半桥）：gateway 审批上下文只有 sessionId 无 caseId，
 * graph=inventiveness 运行时把绑定落盘到 `<caseDir>/workflow-runs/session-binding.json`，
 * 审批驳回/修改回调按 sessionId 反查 caseId 后才能把反馈落到正确的 case 文件。
 * 归属是近似：同 session 先后跑多个 case 时取 boundAt 最新（last-write-wins）；
 * 同 session 内其它链路的审批也会命中绑定——反馈记录带 trigger 溯源供事后甄别。
 */
export const SESSION_BINDING_FILE = "session-binding.json";

export type SessionCaseBinding = {
  sessionId: string;
  boundAt: string;
  /** 写入绑定的链路标识（如 "inventiveness"）：反馈记录按 session 近似归属，
   * 此字段标记绑定来源供事后甄别（审批回调无法验证产出与该链路相关）。 */
  graph?: string;
};

/** `<root>/data/cases/<caseId>/workflow-runs/session-binding.json`（与 caseWorkflowRunsDir 同约定）。 */
export function caseSessionBindingPath(caseId: string): string {
  return `data/cases/${caseId}/${CASE_WORKFLOW_RUNS_REL}/${SESSION_BINDING_FILE}`;
}

/** 写绑定（覆盖式；目录不存在时创建；失败由调用方 fail-open）。 */
export async function saveSessionCaseBinding(filePath: string, binding: SessionCaseBinding): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(binding), { encoding: "utf8" });
}

/**
 * 反查绑定该 sessionId 的 caseId：扫描 `<casesRoot>/<caseId>/workflow-runs/session-binding.json`。
 * 多个 case 绑定同一 sessionId 时取 boundAt 最新的（真 last-write-wins；缺失/坏 boundAt 视为最旧）。
 * cases 根不存在/目录不可读/绑定缺失或损坏 → 跳过（fail-open，返回 undefined）。
 */
export async function findCaseIdBySession(casesRoot: string, sessionId: string): Promise<string | undefined> {
  let entries: Dirent[];
  try {
    entries = await readdir(casesRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  let best: { caseId: string; boundAt: string } | undefined;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = await readFile(join(casesRoot, entry.name, CASE_WORKFLOW_RUNS_REL, SESSION_BINDING_FILE), "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionCaseBinding>;
      if (parsed.sessionId !== sessionId) continue;
      const boundAt = typeof parsed.boundAt === "string" ? parsed.boundAt : "";
      if (best === undefined || boundAt > best.boundAt) best = { caseId: entry.name, boundAt };
    } catch {
      // 无绑定或坏 JSON：跳过。
    }
  }
  return best?.caseId;
}
