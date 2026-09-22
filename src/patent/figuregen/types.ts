/**
 * src/patent/figuregen — 专利附图生成数据契约。
 *
 * LLM 只产 FigureSpec（结构化节点/边/附图标记），渲染与校验均为确定性纯函数：
 * 附图标记（ref）是结构化字段而非文本后处理，生成期写入 SVG `data-ref` 属性，
 * 使核验器可独立回读已交付文件。规则依据见 skills/patent-illustrator/references/
 * cn-drawing-rules.md（细则 2023 第 20/21 条、审查指南 2023 一部一章 4.3/4.5.2/4.6）。
 *
 * 曲线图（`kind: "chart"`）把"节点 + 边"换成"坐标轴 + 数据序列"（`chart` 字段），走直接绘制的
 * 矢量通路（布局与绘制见 `chart.ts`）——坐标轴、刻度与曲线不是图论结构，Graphviz 表达不了。
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
 * - `chart` 曲线图/坐标图（性能数据坐标图；**只有内置渲染器能画**——graphviz 无法
 *   表达坐标轴与数据曲线，故该图型下 `SATI_FIGURE_RENDERER` 只能为 builtin）
 */
export type FigureKind = "flowchart" | "block" | "state" | "hierarchy" | "chart";

/** 布局主方向：TB=自上而下（方法流程默认），LR=自左向右（系统框图默认）。曲线图不使用（恒为横轴在下、纵轴在左）。 */
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

/** 数据点 `[x, y]`（须为有限数；缺项的序列在布局期跳过该点）。 */
export type ChartPoint = readonly [number, number];

/**
 * 坐标轴。轴标目（含单位）必填：图面上不写标目，读者无从知道曲线两个方向各是什么量。
 * 数值范围缺省按数据推导，并按 1/2/2.5/5 × 10^n 的步长向外取整（刻度值是可读的整数，
 * 不是数据的原始极值）。
 */
export type ChartAxis = {
  /** 轴标目，含单位时写在一处，如"时间(h)""转化率(%)"。 */
  title: string;
  /** 轴范围下限（缺省按数据推导）。 */
  min?: number;
  /** 轴范围上限（缺省按数据推导）。 */
  max?: number;
  /** 目标刻度数（含两端，2..12），缺省 5；自动范围时按步长取整，实际个数可能不同。 */
  ticks?: number;
};

/**
 * 数据曲线的标记形状。黑白附图不得用颜色区分曲线（构造期黑白不变式），标记与线型是
 * **唯二**的区分手段，故未指定标记的多序列按固定顺序自动分配不同标记。
 */
export type ChartMarker =
  | "none"
  | "circle"
  | "square"
  | "triangle"
  | "filled-circle"
  | "filled-square"
  | "filled-triangle"
  | "cross"
  | "plus";

/** 曲线线型（与标记共同构成图面上的区分特征）。 */
export type ChartLineStyle = "solid" | "dashed" | "dotted";

/** 一条数据曲线。 */
export type ChartSeries = {
  /** 序列名（图例文本）；缺省则该曲线不上图例。 */
  name?: string;
  /** 数据点（按 x 升序给出，按给定顺序连线，不重排）。 */
  points: ChartPoint[];
  /** 标记形状；缺省按序列序号取不同的默认标记（多序列可区分）。 */
  marker?: ChartMarker;
  /** 线型；缺省实线。 */
  line?: ChartLineStyle;
};

/** 曲线图数据（`kind: "chart"` 时使用；此时 `nodes`/`edges` 为空数组）。 */
export type FigureChart = {
  x: ChartAxis;
  y: ChartAxis;
  series: ChartSeries[];
  /** 是否画网格线（细实线，默认 false）。 */
  grid?: boolean;
  /** 是否写图例（默认 true；只列有 name 的序列）。 */
  legend?: boolean;
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
  /** 曲线图数据（`kind: "chart"` 时必填；其余图型忽略）。 */
  chart?: FigureChart;
};

export type DocumentKind = "invention" | "utility";

/**
 * 法域（目标受理局/指定局）：cn=CNIPA（默认）、us=USPTO、pct=PCT 国际申请。
 * 影响图号写法、纸面常数与规则适用（见 `office-profile.ts` 的档案；cn/us 的历史行为不变）。
 */
export type Jurisdiction = "cn" | "us" | "pct";
