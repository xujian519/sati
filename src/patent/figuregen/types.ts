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
  | "doublecircle"
  // 电路图（kind="circuit"）的元件符号：按 IEC 矩形符号画（电阻=矩形、电容=极板、
  // 电感=方波、二极管=三角+竖线、电源=圆圈+极性、接地=递减横线、开关=断触点、
  // 灯泡=圆内叉、电池=长短极板对）。
  | "resistor"
  | "capacitor"
  | "inductor"
  | "diode"
  | "source"
  | "ground"
  | "switch"
  | "lamp"
  | "battery";

/**
 * 附图类型。
 * - `flowchart` 方法流程图（默认纵向）
 * - `block` 系统结构框图（默认横向）
 * - `state` 状态转移图（默认纵向；初态/终态用 circle/doublecircle 符号）
 * - `hierarchy` 组件层级图（默认纵向；连线表示包含关系，不画箭头）
 * - `chart` 曲线图/坐标图（性能数据坐标图；**只有内置渲染器能画**——graphviz 无法
 *   表达坐标轴与数据曲线，故该图型下 `SATI_FIGURE_RENDERER` 只能为 builtin）
 * - `sequence` 时序图（参与者生命线 + 消息；节点=参与者、边=消息，**复用同一套
 *   nodes/edges 结构**，不另开数据结构）
 * - `circuit` 电路图（元件符号 + 连线；节点形状取电路元件名）
 */
export type FigureKind =
  | "flowchart"
  | "block"
  | "state"
  | "hierarchy"
  | "chart"
  | "sequence"
  | "circuit"
  | "cross-section";

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

/**
 * 二维剖视的一个**断面零件**（被剖切零件的截面轮廓）。
 *
 * 语义对齐 GB/T 4457.5《机械制图 剖面区域的表示法》：断面区域内画**细实线**的平行剖面线，
 * 与水平线成 45°，**同一零件间距相等方向一致**，**相邻零件方向相反**（否则相邻零件会被
 * 读成一个整体）。
 *
 * 坐标：**归一化坐标**（0..1，x 向右、y 向下）—— 调用方不必知道输出画布的像素尺寸，
 * 渲染器按画布映射。轮廓顶点至少 3 个，自动闭合。
 */
export type FigureSectionPart = {
  /** 稳定 id（跨图同一零件沿用同一 id，供 V4 一致性核验）。 */
  id: string;
  /** 零件名（图面文字，可选）。 */
  label?: string;
  /** 附图标记（可选）：剖视图里的部件同样要能被 V2/V3/V4 双向核对。 */
  ref?: number;
  /** 断面轮廓顶点（归一化坐标，至少 3 点，自动闭合）。 */
  outline: readonly (readonly [number, number])[];
  /** 孔（闭合多边形，归一化坐标）：孔内**不**填剖面线（孔是空的）。 */
  holes?: readonly (readonly (readonly [number, number])[])[];
  /** 本零件**不画**剖面线（缺省 false）：用于「只画轮廓不剖」的零件。 */
  no_hatch?: boolean;
};

/**
 * 二维剖视（`kind: "cross-section"`）的输入。
 *
 * 口径：调用方给出**断面轮廓**（被剖零件的截面形状），渲染器负责在断面内画剖面线、
 * 画轮廓与剖切线、写零件名与附图标记。
 */
export type FigureSection = {
  /** 断面零件（至少 1 个）。 */
  parts: readonly FigureSectionPart[];
  /** 剖切线（归一化坐标，两点确定一条直线；缺省不画剖切位置线）。 */
  cut?: readonly (readonly [number, number])[];
  /** 剖面线间距（px）；缺省按模块常量。 */
  hatch_spacing?: number;
  /** 剖面线与水平线的夹角（度）；缺省 45°（相邻零件自动取 135° 交替）。 */
  hatch_angle_deg?: number;
};

/**
 * 一个**面板**（多面板附图的一格，如 FIG.1A / FIG.1B）。
 *
 * 面板复用 `nodes`/`edges` 结构（与单幅附图同构）⇒ 面板内节点可带 `ref`，
 * 多面板**共享同一套附图标记系列**（同一部件在 FIG.1A 与 FIG.1B 里是同一个号）。
 */
export type FigurePanel = {
  /** 面板标题（如「图 1A」的面板说明）；缺省不画。 */
  title?: string;
  /** 面板内布局方向；缺省继承主图。 */
  direction?: FigureDirection;
  nodes: FigureNode[];
  edges: FigureEdge[];
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
  /**
   * 二维剖视的输入（`kind: "cross-section"` 时必填；其余图型忽略）。
   */
  section?: FigureSection;
  /**
   * 多面板（FIG.1A / FIG.1B 这类部分视图）：给出时按面板网格渲染一幅图，
   * 各面板**共享同一套附图标记系列**。
   *
   * 与 `nodes`/`edges` 的关系：`panels` 存在时它承载图面内容（顶层 nodes/edges 忽略），
   * `kind` 仍决定各面板内部的图型语义（flowchart/block/…）。
   */
  panels?: FigurePanel[];
};

export type DocumentKind = "invention" | "utility";

/**
 * 一幅附图的**节点集合**（面板摊平后的口径）。
 *
 * 多面板附图（`panels`）的节点住在各面板里，而核验（V2/V3/V4）、标号归一、图面用语、
 * 附图说明、标号表这些**与渲染无关**的管线要看到「全部节点」⇒ 统一走这个 helper，
 * 免得各处各写一遍 `panels ?? [顶层]` 而漏掉一处（漏一处 ⇒ 面板里的标记在核验侧消失，
 * 即「声明了却没核验」的假保证）。
 *
 * `panels` 存在且非空时**以面板为准**（顶层 nodes/edges 被忽略）；否则用顶层 nodes。
 */
export function figureNodes(figure: FigureSpec): FigureNode[] {
  if (figure.section !== undefined && figure.section.parts.length > 0) {
    // 剖视图：节点 = 断面零件（id/label/ref）⇒ 剖视图里的部件同样进核验与标号表。
    return figure.section.parts.map(part => ({
      id: part.id,
      label: part.label ?? part.id,
      ...(part.ref === undefined ? {} : { ref: part.ref }),
    }));
  }
  return figure.panels !== undefined && figure.panels.length > 0
    ? figure.panels.flatMap(panel => panel.nodes)
    : figure.nodes;
}

/** 一幅附图的**边集合**（面板摊平后的口径；与 {@link figureNodes} 同规则）。 */
export function figureEdges(figure: FigureSpec): FigureEdge[] {
  return figure.panels !== undefined && figure.panels.length > 0
    ? figure.panels.flatMap(panel => panel.edges)
    : figure.edges;
}

/**
 * 法域（目标受理局/指定局）：cn=CNIPA（默认）、us=USPTO、pct=PCT 国际申请。
 * 影响图号写法、纸面常数与规则适用（见 `office-profile.ts` 的档案；cn/us 的历史行为不变）。
 */
export type Jurisdiction = "cn" | "us" | "pct";
