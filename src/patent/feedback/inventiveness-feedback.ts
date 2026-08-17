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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
