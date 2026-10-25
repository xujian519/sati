/**
 * 时间基准原子：time-baseline（确定性，无 LLM）。
 *
 * 对抗七步 ②③ 的「行为时点」：把申请日/优先权日归一为 run 可直接消费的
 * 截止日事实，优先级 `priority_date` > `filing_date`。缺两者时不假定今天，
 * 输出 `degraded: true` + 空 `cutoffDate` + 明示原因。
 *
 * 日期解析与月级→月末规则复用 `src/patent/evidence/date.ts`（单一实现）。
 * 输入来源：
 * 1. 显式 state 键 `priority_date` / `filing_date`（自定义 manifest / 宿主注入）；
 * 2. `inventiveness_parse`（图路径 parse 节点的 JSON 输出）；
 * 3. `parse`（收口模式 parse 阶段文本，若为 JSON）。
 */

import { type Atom } from "../../atom.js";
import { type PipelineState, type StageExecuteInput, type StageHandler, getStateString } from "../../handler.js";
import { normalizeToCutoffDate } from "../../../evidence/date.js";
import { tryParseJson } from "../../../llm-json.js";

export type TimeBaselineBasis = "filing" | "priority" | "unknown";

/** 时间基准结构化产物（`time_baseline` JSON 的形状）。 */
export type TimeBaseline = {
  /** 截止日（YYYY-MM-DD）；未确定时为空串。 */
  cutoffDate: string;
  basis: TimeBaselineBasis;
  degraded: boolean;
  /** 降级原因（仅 degraded 时给出）。 */
  note?: string;
};

export const timeBaselineAtom: Atom = {
  name: "time-baseline",
  description: "确定现有技术时间基准（优先权日 > 申请日；缺失时显式降级，不假定今天）",
  category: "extract",
  inputSchema: ["priority_date", "filing_date", "inventiveness_parse", "parse"],
  outputSchema: ["time_baseline", "cutoff_date", "cutoff_basis", "cutoff_degraded"],
};

/** 从已解析 JSON 文本中读取日期字段（仅接受字符串）。 */
function readParsedDates(state: PipelineState): { priority_date: string; filing_date: string } {
  for (const key of ["inventiveness_parse", "parse"]) {
    const raw = getStateString(state, key);
    if (raw.trim().length === 0) continue;
    const parsed = tryParseJson(raw);
    if (parsed === undefined) continue;
    const priority = typeof parsed.priority_date === "string" ? parsed.priority_date : "";
    const filing = typeof parsed.filing_date === "string" ? parsed.filing_date : "";
    if (priority.trim().length > 0 || filing.trim().length > 0) {
      return { priority_date: priority, filing_date: filing };
    }
  }
  return { priority_date: "", filing_date: "" };
}

/** 按候选顺序取第一个可解析的截止日（空串跳过；非法值继续尝试后续候选）。 */
function firstCutoff(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate.trim().length === 0) continue;
    const normalized = normalizeToCutoffDate(candidate);
    if (normalized !== undefined) return normalized;
  }
  return undefined;
}

export class TimeBaselineHandler implements StageHandler {
  readonly name = "time-baseline";
  readonly category = "extract" as const;

  async execute({ state }: StageExecuteInput): Promise<PipelineState> {
    const parsed = readParsedDates(state);
    const priorityCutoff = firstCutoff([getStateString(state, "priority_date"), parsed.priority_date]);
    const filingCutoff = firstCutoff([getStateString(state, "filing_date"), parsed.filing_date]);

    const baseline: TimeBaseline = priorityCutoff
      ? { cutoffDate: priorityCutoff, basis: "priority", degraded: false }
      : filingCutoff
        ? { cutoffDate: filingCutoff, basis: "filing", degraded: false }
        : {
            cutoffDate: "",
            basis: "unknown",
            degraded: true,
            note: "未确定截止日（缺少或无法解析申请日/优先权日，不得假定今天）",
          };

    return {
      time_baseline: JSON.stringify(baseline),
      cutoff_date: baseline.cutoffDate,
      cutoff_basis: baseline.basis,
      cutoff_degraded: baseline.degraded,
    };
  }
}
