/**
 * src/patent/figure/symbols — 电学符号知识库（GB/T 4728 / IEC 60617 简化子集）。
 *
 * 用途：
 * 1. analyze_patent_figure 的 Step3（电学深度分析）将符号库摘要注入提示词，
 *    引导多模态模型按标准符号集识别元件；
 * 2. symbol-validator（validator.ts）以符号库为确定性校验依据（标号前缀 ↔ 符号类别）。
 *
 * 数据源：src/patent/figure/symbols/electrical-symbols.yaml（构建时拷贝进 dist，
 * 与 ipc-standards.yaml 同机制）。
 */

/** 电学元件大类（符号库分类维度）。 */
export const ELECTRICAL_SYMBOL_CATEGORIES = [
  "passive", // 无源元件：电阻/电容/电感/变压器
  "semiconductor", // 半导体：二极管/三极管/场效应管/晶闸管/光电器件
  "ic", // 集成电路：运放/逻辑门/芯片/光耦
  "power", // 电源：电池/直流电源/交流源/地
  "switch", // 开关与保护：开关/继电器/熔断器
  "connector", // 接插件：连接器/接线端子
  "sensor", // 传感器
  "display", // 显示与指示：LED/数码管/指示灯
  "motor", // 电机
  "misc", // 其他：晶振/天线/扬声器/话筒
] as const;

export type ElectricalSymbolCategory = (typeof ELECTRICAL_SYMBOL_CATEGORIES)[number];

export const ELECTRICAL_SYMBOL_CATEGORY_NAMES: Record<ElectricalSymbolCategory, string> = {
  passive: "无源元件",
  semiconductor: "半导体器件",
  ic: "集成电路",
  power: "电源",
  switch: "开关与保护",
  connector: "接插件",
  sensor: "传感器",
  display: "显示与指示",
  motor: "电机",
  misc: "其他",
};

/** 电学符号条目（electrical-symbols.yaml 的解析形态）。 */
export type ElectricalSymbolEntry = {
  /** 稳定 id（如 "resistor"）。 */
  id: string;
  /** 中文名称。 */
  nameZh: string;
  /** 英文名称。 */
  nameEn: string;
  /** 元件大类。 */
  category: ElectricalSymbolCategory;
  /** 常见附图标记前缀（如 R / C / D / Q / U / IC…；同一符号可有多个惯例前缀）。 */
  refPrefix: string[];
  /** 典型引脚数（两端/三端/多端；不固定为 undefined）。 */
  terminalCount?: number;
  /** 参数单位（如 Ω / F / H；无参数元件为 undefined）。 */
  valueUnit?: string;
  /** 标准画法要点（GB/T 4728 简化描述，注入提示词供模型对照）。 */
  drawingHints: string;
  /** 语义说明（元件功能，注入提示词供模型理解）。 */
  semantics: string;
};

/** 电学符号知识库索引。 */
export type ElectricalSymbolIndex = {
  /** 全量条目。 */
  all: ElectricalSymbolEntry[];
  /** 按附图标记前缀（大写）索引，一个前缀可对应多个符号。 */
  byRefPrefix: Map<string, ElectricalSymbolEntry[]>;
  /** 按 id 索引。 */
  byId: Map<string, ElectricalSymbolEntry>;
};
