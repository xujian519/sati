/**
 * src/patent/figuregen — FigureSpec → Graphviz DOT 源（确定性纯函数）。
 *
 * Graphviz 可选渲染器（复杂大图增强）的第一段：同输入永远产出同一 DOT 文本
 * （快照测试前提）。黑白合规（指南一部一章 4.3/4.6）在 DOT 层即已固化：
 * 仅 #000000/#FFFFFF、无渐变、无彩色函数；颜色统一写十六进制，使 dot 的
 * SVG 输出可直接过黑白不变式扫描。节点 id 以带引号 DOT id 原样传递，
 * graphviz 会把它写进 SVG <title>，供 data-ref 注入与 readback 回读。
 * 节点 label 与内置渲染器同口径：带 ref 而未带可见标号时补画 `(ref)`（见 numeral-assign.ts）。
 */

import { figureCaption, profileForJurisdiction } from "./office-profile.js";
import { isSymbolShape } from "./layout.js";
import { edgeFontPt, figureFontPt } from "./metrics.js";
import { withVisibleNumeral } from "./numeral-assign.js";
import type { FigureNode, FigureNodeShape, FigureSpec, Jurisdiction } from "./types.js";

/** 初态实心圆的固定直径（英寸；graphviz 单位为英寸）。 */
const INITIAL_STATE_DIAMETER_IN = 0.22;

const DOT_SHAPE: Readonly<Record<FigureNodeShape, { shape: string; style?: string }>> = {
  rect: { shape: "box" },
  round: { shape: "box", style: "rounded,filled" },
  diamond: { shape: "diamond" },
  ellipse: { shape: "ellipse" },
  cylinder: { shape: "cylinder" },
  parallelogram: { shape: "parallelogram" },
  circle: { shape: "circle", style: "filled" },
  doublecircle: { shape: "doublecircle" },
  // 电路元件：graphviz 没有元件符号 ⇒ 退化为「方框 + 名称」（dot 通路上电路图整体
  // fail-loud，见 buildDot 的图型闸门 ⇒ 这张表只是穷尽性兜底，不会真的被渲染）。
  resistor: { shape: "box" },
  capacitor: { shape: "box" },
  inductor: { shape: "box" },
  diode: { shape: "box" },
  source: { shape: "ellipse" },
  ground: { shape: "triangle" },
  switch: { shape: "box" },
  lamp: { shape: "ellipse" },
  battery: { shape: "box" },
};

/** DOT 带引号字符串转义：反斜杠、引号与换行（换行写作 \n 字面量，dot 出多行文本）。 */
export function dotEscape(text: string): string {
  return text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r\n", "\n").replaceAll("\n", "\\n");
}

function nodeAttrs(node: FigureNode): string {
  const { shape, style } = DOT_SHAPE[node.shape ?? "rect"];
  // 符号节点（状态图初态/终态）无文字：label 置空，初态另填黑。
  // 附图标记归一：节点有 ref 而 label 未带可见标号时补画 `(ref)`（与内置渲染器同观感；
  // 补画后仍走 dotEscape，括号在带引号的 label 里无需另转义）。
  const visible = isSymbolShape(node.shape)
    ? ""
    : node.ref === undefined
      ? node.label
      : withVisibleNumeral(node.label, node.ref);
  const attrs = [`label="${dotEscape(visible)}"`, `shape="${shape}"`];
  if (style !== undefined) {
    attrs.push(`style="${style}"`);
  }
  if (node.shape === "circle") {
    attrs.push(
      'fillcolor="#000000"',
      "fixedsize=true",
      `width=${INITIAL_STATE_DIAMETER_IN}`,
      `height=${INITIAL_STATE_DIAMETER_IN}`,
    );
  }
  return attrs.join(", ");
}

/**
 * 渲染单幅附图为 DOT 源（确定性，同 FigureSpec 逐字节一致）。
 *
 * 图号是否需要标注由图幅数与法域档案决定（单幅在 PCT/US 不得出现 "Fig."）：
 * 不编号时**不输出 caption 属性**（而不是画一个空 label——空 label 会占位）。
 * 层级图的边表示包含关系，`arrowhead="none"` 与内置渲染器同观感。
 *
 * 曲线图（kind: "chart"）**fail-loud**：Graphviz 只表达"节点 + 边"，画不出坐标轴、
 * 刻度与数据曲线；静默出一张空图会让"要 graphviz 布局"的意图变成一张错图。
 *
 * 时序图（sequence）、电路图（circuit）与多面板（panels）同理 fail-loud：生命线、
 * 元件符号、面板网格都不是 graphviz 的表达能力 ⇒ 同一理由（画错图比报错更坏）。
 */
export function buildFigureDot(
  spec: FigureSpec,
  options: { jurisdiction?: Jurisdiction; figureCount?: number } = {},
): string {
  if (spec.kind === "chart") {
    throw new TypeError(
      `图${spec.figure_no} 是曲线图（kind="chart"），只能由内置渲染器绘制：graphviz 无法表达坐标轴与数据曲线` +
        `（请去掉 SATI_FIGURE_RENDERER 或设为 builtin）`,
    );
  }
  if (spec.kind === "sequence" || spec.kind === "circuit") {
    throw new TypeError(
      `图${spec.figure_no} 是${spec.kind === "sequence" ? "时序图" : "电路图"}（kind="${spec.kind}"），` +
        `只能由内置渲染器绘制：graphviz 无法表达${spec.kind === "sequence" ? "生命线与消息时序" : "电路元件符号"}` +
        `（请去掉 SATI_FIGURE_RENDERER 或设为 builtin）`,
    );
  }
  if (spec.panels !== undefined && spec.panels.length > 0) {
    throw new TypeError(
      `图${spec.figure_no} 是多面板附图（panels），只能由内置渲染器绘制：graphviz 无面板网格概念` +
        `（请去掉 SATI_FIGURE_RENDERER 或设为 builtin）`,
    );
  }
  const direction = spec.direction ?? (spec.kind === "block" ? "LR" : "TB");
  const caption = figureCaption(profileForJurisdiction(options.jurisdiction), spec.figure_no, options.figureCount ?? 1);
  // 字号由部署级 SATI_FIGURE_FONT_MM 折算（缺省 14pt / 边标签 12pt，与既有快照一致）。
  const fontSizePt = figureFontPt();
  const edgeFontSizePt = edgeFontPt(fontSizePt);
  const lines: string[] = [
    "digraph {",
    '  bgcolor="#FFFFFF";',
    `  rankdir="${direction}";`,
    ...(caption === undefined ? [] : [`  label="${dotEscape(caption)}";`, '  labelloc="b";']),
    '  fontname="sans-serif";',
    `  fontsize=${fontSizePt};`,
    `  node [fontname="sans-serif", fontsize=${fontSizePt}, style="filled", fillcolor="#FFFFFF", color="#000000", fontcolor="#000000"];`,
    `  edge [fontname="sans-serif", fontsize=${edgeFontSizePt}, color="#000000", fontcolor="#000000"` +
      `${spec.kind === "hierarchy" ? ', arrowhead="none"' : ""}];`,
  ];
  for (const node of spec.nodes) {
    lines.push(`  "${dotEscape(node.id)}" [${nodeAttrs(node)}];`);
  }
  for (const edge of spec.edges) {
    const attrs: string[] = [];
    if (edge.label !== undefined) {
      attrs.push(`label="${dotEscape(edge.label)}"`);
    }
    if (edge.dashed === true) {
      attrs.push("style=dashed");
    }
    const suffix = attrs.length > 0 ? ` [${attrs.join(", ")}]` : "";
    lines.push(`  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${suffix};`);
  }
  lines.push("}", "");
  return lines.join("\n");
}
