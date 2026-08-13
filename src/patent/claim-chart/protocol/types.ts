/**
 * claim-chart 协议层：权利要求要素级证据网格（Claim Chart）的数据契约。
 *
 * 行业标准依据（见 spec）：两列表（左=要素编号 verbatim，右=证据 pin-cite）、
 * mapping 状态机、gap list 第一优先输出、draft notice 免责声明。
 */

export type ElementKind = "preamble" | "transitional" | "limitation" | "means-plus-function" | "markush-member";

export interface ClaimElement {
  /** 稳定编号（表脊），如 "1a"/"1b"/"2a"；格式：数字+小写字母。 */
  id: string;
  /** 权利要求序号（与 id 前缀一致）。 */
  claimNo: number;
  /** 要素原文，必须是权利要求原文的连续子串（element-validator 强制）。 */
  text: string;
  kind: ElementKind;
  /** 需 claim construction 的争议术语（可选）。 */
  disputedTerm?: string;
}

export type ChartMode = "infringement" | "invalidity" | "oa-response" | "reexamination" | "patentability";

export type TargetKind = "prior-art" | "accused-product";

export interface ChartTarget {
  /** "D1"/"D2"/"产品A"。 */
  id: string;
  kind: TargetKind;
  /** 对比文件 converted 全文 / 产品材料文件路径（pin-cite 校验数据源，可选）。 */
  sourcePath?: string;
  title?: string;
}

export type Mapping =
  | "literal"
  | "literal-construction-dependent"
  | "doe"
  | "anticipation"
  | "obviousness-combination"
  | "partial"
  | "not-found"
  | "needs-evidence"
  | "construction-dependent";

export type RowState = Mapping;

export interface ChartRow {
  elementId: string;
  targetId: string;
  /** 目标（对比文件/产品证据）verbatim 引用。 */
  quote: string;
  /** "[D1 段[0032] 图3]" 形式，必须能在源文定位（pin-cite-validator 强制）。 */
  pinCite: string;
  mapping: Mapping;
  state: RowState;
  /** HITL 核验标记；重跑时保留已核验行。 */
  verified: boolean;
  note?: string;
}

export interface GapEntry {
  elementId: string;
  targetId: string;
  mapping: Mapping;
  /** 缺口原因说明。 */
  reason: string;
  /** 建议动作（补充检索/证据固化/等同分析）。 */
  suggestion: string;
}

export const DRAFT_NOTICE =
  "本表为分析草稿，供代理人与律师核验使用，不构成正式法律意见或诉讼主张。每一行映射均须对照源文件人工复核。";

export interface ClaimChart {
  chartId: string;
  mode: ChartMode;
  caseId: string;
  /** 已拆分的要素（渲染表格左列与 gap list 需要）。 */
  elements: ClaimElement[];
  claimNos: number[];
  targets: ChartTarget[];
  rows: ChartRow[];
  /** 第一优先输出。 */
  gaps: GapEntry[];
  draftNotice: string;
}
