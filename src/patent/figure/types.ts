/**
 * src/patent/figure — 专利附图智能分析（PatentVision / PatentLMM 方法落地）。
 *
 * 数据模型：附图类型、组件、连接关系、附图标记与分析结果。
 * 命名对齐 Sati 专利域（src/patent/）既有风格；不依赖 tool 层，供工具与
 * 后续撰写/校验管线共用。
 */

/** 附图类型（PatentVision 分类 + 专利实务常见图型）。 */
export const FIGURE_TYPES = [
  "structure",
  "flowchart",
  "circuit",
  "block_diagram",
  "schematic",
  "exploded_view",
  "cross_section",
  "unknown",
] as const;

export type FigureType = (typeof FIGURE_TYPES)[number];

/** 附图类型中文名（附图说明模板用）。 */
export const FIGURE_TYPE_NAMES: Record<FigureType, string> = {
  structure: "结构示意图",
  flowchart: "流程图",
  circuit: "电路图",
  block_diagram: "方框图",
  schematic: "原理示意图",
  exploded_view: "分解示意图",
  cross_section: "剖视图",
  unknown: "示意图",
};

/** 组件类型（PatentVision ComponentType 对齐）。 */
export const FIGURE_COMPONENT_KINDS = [
  "mechanical",
  "electrical",
  "software",
  "interface",
  "sensor",
  "actuator",
  "controller",
  "unknown",
] as const;

export type FigureComponentKind = (typeof FIGURE_COMPONENT_KINDS)[number];

/** 组件连接关系类型。 */
export const FIGURE_CONNECTION_KINDS = ["electrical", "mechanical", "data_flow", "unknown"] as const;

export type FigureConnectionKind = (typeof FIGURE_CONNECTION_KINDS)[number];

/** 附图中的技术组件（对应附图标记号）。 */
export type FigureComponent = {
  /** 附图标记号（与图面阿拉伯数字一致；无标号部件以 U1/U2… 表示）。 */
  refNumber: string;
  /** 组件名称。 */
  name: string;
  /** 组件类型。 */
  kind: FigureComponentKind;
  /** 组件功能描述。 */
  description: string;
};

/** 组件间连接关系。 */
export type FigureConnection = {
  /** 源组件标号。 */
  source: string;
  /** 目标组件标号。 */
  target: string;
  /** 连接类型。 */
  kind: FigureConnectionKind;
  /** 连接关系描述。 */
  description: string;
};

/**
 * 电气元件大类（电学深度分析 Step3 输出）。
 * 与 symbols 模块的 ELECTRICAL_SYMBOL_CATEGORIES 对齐，另含 "unknown"（无法映射）。
 */
export const ELECTRICAL_CATEGORIES = [
  "passive",
  "semiconductor",
  "ic",
  "power",
  "switch",
  "connector",
  "sensor",
  "display",
  "motor",
  "misc",
  "unknown",
] as const;

export type ElectricalCategory = (typeof ELECTRICAL_CATEGORIES)[number];

/** 电学符号元件（符号级识别结果，对应附图标记）。 */
export type ElectricalComponent = {
  /** 附图标记（如 "R1"，与图面字母前缀+编号一致）。 */
  ref: string;
  /** 符号库 id（resistor/capacitor/…；无法匹配为 "unknown"）。 */
  symbol: string;
  /** 元件大类。 */
  category: ElectricalCategory;
  /** 元件中文名称（如 "电阻"）。 */
  name: string;
  /** 电气参数（图上明确标注时，如 "10kΩ"；否则省略）。 */
  value?: string;
  /** 引脚数（如识别）。 */
  terminalCount?: number;
};

/** 电路网络（电气连通关系）。 */
export type ElectricalNet = {
  /** 网络名（VCC / GND / 节点号如 N1）。 */
  name: string;
  /** 连接到该网络的元件引脚，格式 "元件标号.引脚号"（如 "R1.1"）。 */
  connectedRefs: string[];
};

/** 电学深度分析结果（Step3，仅附图类型为 circuit/schematic 时产生）。 */
export type ElectricalAnalysis = {
  components: ElectricalComponent[];
  nets: ElectricalNet[];
  /** SPICE 风格网表文本（尽力而为；不可用时省略）。 */
  netlist?: string;
};

/**
 * 附图分析结果。
 *
 * `figureDescription` 为可直接落入说明书「附图说明」章节的文字（专利格式：
 * "图N是本发明实施例提供的…的结构示意图；图中：1-…；2-…；"）。
 * `usable` 表示结果是否达到可直接用于撰写/校验的置信门槛（组件数 > 0 且
 * 置信度 ≥ 0.6），供上层决定是否需要人工确认。
 */
export type FigureAnalysisResult = {
  /** 分析图片路径（工作区相对路径）。 */
  imagePath: string;
  /** 附图编号。 */
  figureNumber: number;
  /** 附图类型。 */
  figureType: FigureType;
  /** 附图整体描述。 */
  overallDescription: string;
  /** 识别出的组件列表。 */
  components: FigureComponent[];
  /** 组件间连接关系。 */
  connections: FigureConnection[];
  /** 附图说明文字（专利格式）。 */
  figureDescription: string;
  /** 整体置信度 0-1。 */
  confidence: number;
  /** 警告（标号不连续、无法识别区域、降级原因等）。 */
  warnings: string[];
  /** 是否可直接用于撰写/校验（组件数 > 0 且置信度 ≥ 0.6）。 */
  usable: boolean;
  /** 实际使用的模型标识（provider/model）。 */
  modelUsed: string;
  /** 电学深度分析结果（仅当附图类型为 circuit/schematic 时存在）。 */
  electrical?: ElectricalAnalysis;
};

/**
 * 枚举值校验工厂：非合法值返回 fallback。
 * 三个 normalize 函数（figureType/componentKind/connectionKind）同构，经此工厂生成。
 */
function makeNormalizer<T extends string>(values: readonly T[], fallback: T) {
  return (value: unknown): T =>
    typeof value === "string" && (values as readonly string[]).includes(value) ? (value as T) : fallback;
}

/** 附图类型枚举值校验：非合法值返回 "unknown"。 */
export const normalizeFigureType = makeNormalizer(FIGURE_TYPES, "unknown");

/** 组件类型枚举值校验：非合法值返回 "unknown"。 */
export const normalizeComponentKind = makeNormalizer(FIGURE_COMPONENT_KINDS, "unknown");

/** 连接类型枚举值校验：非合法值返回 "unknown"。 */
export const normalizeConnectionKind = makeNormalizer(FIGURE_CONNECTION_KINDS, "unknown");

/** 电气元件大类枚举值校验：非合法值返回 "unknown"。 */
export const normalizeElectricalCategory = makeNormalizer(ELECTRICAL_CATEGORIES, "unknown");
