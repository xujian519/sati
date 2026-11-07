/**
 * 修改差分：判断意见陈述里的每条新增限定是否能在原申请文本中定位。
 *
 * 输入走 `text` 里的两段固定标题（patent_workflow_run 的 `input` 会映射到
 * `text`，不需要新增工具字段）：
 *
 * ```text
 * ## original_application
 * ## proposed_limitations
 * ```
 *
 * 缺任一段时状态一律 `not_checked`，不产出 `anchored`。这不是保守，
 * 而是「没核对」与「核对通过」必须可区分（AGENTS.md 第 11 条）。
 */

import { matchFeature } from "../anchor/index.js";

/** 原申请文本段落标题。 */
export const ORIGINAL_APPLICATION_HEADING = "## original_application";
/** 拟修改限定段落标题（一行一条）。 */
export const PROPOSED_LIMITATIONS_HEADING = "## proposed_limitations";

/** 缺段时写入的固定原因。 */
export const NOT_CHECKED_REASON = "输入中没有 original_application 或 proposed_limitations，修改超范围检查未执行";
/** 未命中时写入的固定原因。禁止改成「实质支持」「可以概括」「已有依据」。 */
export const UNSUPPORTED_REASON = "原申请文本中未找到该限定的连续片段";

export type AmendmentDiffStatus = "anchored" | "unsupported" | "not_checked";

export type AmendmentDiffItem = {
  /** 拟新增的限定原文（已去掉项目符号）。缺段占位记录为空串。 */
  limitation: string;
  status: AmendmentDiffStatus;
  /** 命中的原申请文本区间；未命中为空数组。 */
  hits: { start: number; end: number }[];
  reason?: string;
};

export type AmendmentDiff = {
  /** `checked` 表示两段都在并已逐条匹配；`not_checked` 表示缺段。 */
  status: "checked" | "not_checked";
  items: AmendmentDiffItem[];
  reason?: string;
};

type ParsedSection = {
  original: string | null;
  limitations: string[] | null;
};

const HEADING = /^#{1,6}\s+(.*)$/;

function stripBullet(line: string): string {
  return line.replace(/^\s*(?:[-*+•]|\d+[.、)])\s+/, "").trim();
}

/**
 * 解析两段。
 *
 * 标题比较忽略大小写与首尾空白；遇到其它 `#` 标题结束当前段。
 * `proposed_limitations` 接受 `-` / `*` / `•` / `1.` 等项目符号。
 */
export function parseAmendmentInput(text: string): ParsedSection {
  let current: "original" | "limitations" | undefined;
  const originalLines: string[] = [];
  const limitationLines: string[] = [];
  let sawOriginal = false;
  let sawLimitations = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const name = heading[1]!.trim().toLowerCase();
      if (name === ORIGINAL_APPLICATION_HEADING.slice(3)) {
        current = "original";
        sawOriginal = true;
        continue;
      }
      if (name === PROPOSED_LIMITATIONS_HEADING.slice(3)) {
        current = "limitations";
        sawLimitations = true;
        continue;
      }
      current = undefined;
      continue;
    }
    if (current === "original") originalLines.push(rawLine);
    if (current === "limitations") limitationLines.push(line);
  }

  const limitations = sawLimitations ? limitationLines.map(stripBullet).filter(item => item.length > 0) : null;

  return {
    original: sawOriginal ? originalLines.join("\n").trim() : null,
    limitations,
  };
}

/**
 * 逐条核对拟修改限定。
 *
 * 缺少原申请段、缺少限定段、或原申请段为空时返回 `not_checked` 的单条占位记录。
 * 限定段存在但为空表示「本次没有修改」，返回 `checked` 且 `items` 为空。
 */
export function diffAmendments(text: string): AmendmentDiff {
  const parsed = parseAmendmentInput(text);

  if (parsed.original === null || parsed.limitations === null || parsed.original.length === 0) {
    return {
      status: "not_checked",
      reason: NOT_CHECKED_REASON,
      items: [{ limitation: "", status: "not_checked", hits: [], reason: NOT_CHECKED_REASON }],
    };
  }

  const items = parsed.limitations.map<AmendmentDiffItem>(limitation => {
    const match = matchFeature(parsed.original!, limitation);
    return match.hit === null
      ? { limitation, status: "unsupported", hits: [], reason: UNSUPPORTED_REASON }
      : { limitation, status: "anchored", hits: [match.hit] };
  });

  return { status: "checked", items };
}
