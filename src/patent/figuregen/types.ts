/**
 * src/patent/figuregen — 专利附图生成数据契约。
 *
 * LLM 只产 FigureSpec（结构化节点/边/附图标记），渲染与校验均为确定性纯函数：
 * 附图标记（ref）是结构化字段而非文本后处理，生成期写入 SVG `data-ref` 属性，
 * 使核验器可独立回读已交付文件。规则依据见 skills/patent-illustrator/references/
 * cn-drawing-rules.md（细则 2023 第 20/21 条、审查指南 2023 一部一章 4.3/4.5.2/4.6）。
 */

/**
 * 节点形状。各图型语义：
 * - flowchart：rect=步骤 round=起止 diamond=判断 ellipse=端点 cylinder=存储 parallelogram=输入输出
 * - state：round=状态 circle=初态伪状态 doublecircle=终态伪状态
 * - block / hierarchy：rect=模块 cylinder=存储 parallelogram=输入输出
 *
 * `circle`/`doublecircle` 是**符号形状**（不承载文字）：实心小圆与双圈表示状态图的初态/终态，
 * 文字在实心黑底上不可见，故这两个形状的节点 label 被渲染器忽略（check 的 V18 会告警）。
 */
export type FigureNodeShape =
  | "rect"
  | "round"
  | "diamond"
  | "ellipse"
  | "cylinder"
  | "parallelogram"
  | "circle"
  | "doublecircle";

/**
 * 附图类型。
 * - `flowchart` 方法流程图（默认纵向）
 * - `block` 系统结构框图（默认横向）
 * - `state` 状态转移图（默认纵向；初态/终态用 circle/doublecircle 符号）
 * - `hierarchy` 组件层级图（默认纵向；连线表示包含关系，不画箭头）
 */
export type FigureKind = "flowchart" | "block" | "state" | "hierarchy";

/** 布局主方向：TB=自上而下（方法流程默认），LR=自左向右（系统框图默认）。 */
export type FigureDirection = "TB" | "LR";

export type FigureNode = {
  /** 稳定 id（跨图同一组件沿用同一 id，供 V4 一致性核验）。 */
  id: string;
  /** 节点文本，可含 `\n` 换行；附图标记建议写入 label（渲染为"处理模块(20)"）。 */
  label: string;
  /** 专利附图标记（细则第 21 条双向核验对象）；缺省表示纯说明性节点。 */
  ref?: number;
  shape?: FigureNodeShape;
};

export type FigureEdge = {
  from: string;
  to: string;
  /** 边标签（判断分支的"是/否"等）。 */
  label?: string;
  dashed?: boolean;
};

/** 单幅附图的结构化描述。figure_no 必须落在 1..N 连续编号内（细则第 21 条）。 */
export type FigureSpec = {
  figure_no: number;
  kind: FigureKind;
  direction?: FigureDirection;
  nodes: FigureNode[];
  edges: FigureEdge[];
  /** 指定为本申请摘要附图（审查指南一部一章 4.5.2；多图时应指定一幅）。 */
  abstract?: boolean;
};

export type DocumentKind = "invention" | "utility";

/**
 * 法域（目标受理局/指定局）：cn=CNIPA（默认）、us=USPTO、pct=PCT 国际申请。
 * 影响图号写法、纸面常数与规则适用（见 `office-profile.ts` 的档案；cn/us 的历史行为不变）。
 */
export type Jurisdiction = "cn" | "us" | "pct";
