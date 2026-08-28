/**
 * src/patent/figuregen — "附图说明"章节草稿文本（说明书七部分之一，细则第 20 条）。
 *
 * 确定性模板文本：图N 为……；附图标记说明跨图去重、按标记升序、名称剥离括号
 * 标记（与校验器 stripRefMark 同一实现，保证"同一组成部分标记一致"的呈现面）。
 * US 辖区输出英文 BRIEF DESCRIPTION OF THE DRAWINGS（"FIG. N is a ..." 惯用句式）。
 */

import { stripRefMark } from "./check.js";
import type { DocumentKind, FigureSpec, Jurisdiction } from "./types.js";

export type FigureBriefOptions = {
  /** 发明（或实用新型）名称，如"一种数据处理装置"。 */
  inventionName?: string;
  /** 措辞切换：invention→本发明（默认），utility→本实用新型。 */
  documentKind?: DocumentKind;
  /** 辖区（默认 cn）：us 输出英文模板。 */
  jurisdiction?: Jurisdiction;
};

function kindText(kind: FigureSpec["kind"]): string {
  return kind === "block" ? "结构框图" : "方法流程示意图";
}

function kindTextEn(kind: FigureSpec["kind"]): string {
  return kind === "block" ? "block diagram of a system" : "flowchart of a method";
}

export function buildFigureBriefDraft(specs: readonly FigureSpec[], options: FigureBriefOptions = {}): string {
  const sorted = [...specs].sort((a, b) => a.figure_no - b.figure_no);
  const markers = new Map<number, string>();
  for (const figure of specs) {
    for (const node of figure.nodes) {
      if (node.ref !== undefined && !markers.has(node.ref)) {
        markers.set(node.ref, stripRefMark(node.label));
      }
    }
  }

  if (options.jurisdiction === "us") {
    const lines: string[] = ["BRIEF DESCRIPTION OF THE DRAWINGS"];
    for (const figure of sorted) {
      const ofName = options.inventionName === undefined ? "" : ` of the "${options.inventionName}"`;
      lines.push(`FIG. ${figure.figure_no} is a ${kindTextEn(figure.kind)}${ofName} according to an embodiment.`);
    }
    if (markers.size > 0) {
      const items = [...markers.entries()].sort(([a], [b]) => a - b).map(([ref, name]) => `${ref} — ${name}`);
      lines.push("REFERENCE NUMERALS", `${items.join("; ")};`);
    }
    return lines.join("\n");
  }

  const subject = options.documentKind === "utility" ? "本实用新型" : "本发明";
  const lines: string[] = ["附图说明"];
  for (const figure of sorted) {
    const head = options.inventionName === undefined ? "" : `${options.inventionName}的`;
    lines.push(`图${figure.figure_no}为${subject}实施例提供的${head}${kindText(figure.kind)}；`);
  }
  if (markers.size > 0) {
    const items = [...markers.entries()].sort(([a], [b]) => a - b).map(([ref, name]) => `${ref}—${name}`);
    lines.push(`附图标记说明：${items.join("；")}；`);
  }
  return lines.join("\n");
}
