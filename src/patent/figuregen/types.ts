/**
 * src/patent/figuregen — 专利附图生成数据契约。
 *
 * LLM 只产 FigureSpec（结构化节点/边/附图标记），渲染与校验均为确定性纯函数：
 * 附图标记（ref）是结构化字段而非文本后处理，生成期写入 SVG `data-ref` 属性，
 * 使核验器可独立回读已交付文件。规则依据见 skills/patent-illustrator/references/
 * cn-drawing-rules.md（细则 2023 第 20/21 条、审查指南 2023 一部一章 4.3/4.5.2/4.6）。
 */

/** 节点形状。flowchart 语义：rect=步骤 round=起止 diamond=判断 ellipse=端点 cylinder=存储 parallelogram=输入输出。 */
export type FigureNodeShape = "rect" | "round" | "diamond" | "ellipse" | "cylinder" | "parallelogram";

export type FigureKind = "flowchart" | "block";

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
