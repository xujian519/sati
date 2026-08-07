/**
 * src/patent/chemistry — 化学式识别（L1 基础层：文本提取 + RDKit 校验 + VLM 识别）。
 *
 * 数据模型：识别类型、多候选 SMILES、RDKit 校验结果与人工复核标记。
 * 命名对齐 Sati 专利域（src/patent/）既有风格；不依赖 tool 层，供工具与
 * 后续撰写/校验管线共用。
 */

/** 化学实体识别类型。 */
export const CHEMICAL_KINDS = ["formula", "structure", "markush"] as const;

export type ChemicalKind = (typeof CHEMICAL_KINDS)[number];

/** 单条 SMILES 候选（VLM/文本提取产物，经 RDKit 校验）。 */
export type ChemicalSmilesCandidate = {
  /** 原始 SMILES（模型/提取器输出，未经规范化）。 */
  smiles: string;
  /** RDKit 规范化后的 SMILES（仅 valid 时存在）。 */
  canonicalSmiles?: string;
  /** 候选置信度 0-1（来源标注：模型输出或 LLM 复核）。 */
  confidence: number;
  /** 是否通过校验（RDKit 确认结构合法；RDKit 不可用时为语法预检结果）。 */
  valid: boolean;
  /** 校验失败原因（仅 valid=false 时存在）。 */
  validationError?: string;
};

/**
 * 化学式识别结果。
 *
 * 防幻觉约定（评审 H1）：`usable` 表示存在合法且置信度达标的候选；
 * `needHumanReview` 表示全部候选非法、置信度不足或 RDKit 不可用（未验证），
 * 上层应进入人工确认流程而非直接采信。
 */
export type ChemicalStructureResult = {
  /** 识别来源：图片路径（工作区相对路径）。 */
  imagePath?: string;
  /** 识别来源：输入文本（文本/名称模式）。 */
  sourceText?: string;
  /** 识别类型。 */
  kind: ChemicalKind;
  /** 多候选 SMILES（模型输出顺序；选优规则为合法候选中置信度最高者，经 RDKit 规范化）。 */
  candidates: ChemicalSmilesCandidate[];
  /** 选定候选在 candidates 中的下标（-1 表示未选定）。 */
  chosenIndex: number;
  /** 选定候选的规范化 SMILES。 */
  canonicalSmiles?: string;
  /** 分子式（RDKit InChI 公式段提取；文本模式的分子式候选）。 */
  formula?: string;
  /** 化合物名称（模型输出/文本提取）。 */
  names: string[];
  /** 整体置信度 0-1（= 选定候选置信度；公式类型为模型分类置信度）。 */
  confidence: number;
  /** 警告（识别降级原因、校验失败、需人工确认等）。 */
  warnings: string[];
  /** 是否需人工复核（全部候选非法、置信度低于阈值或 RDKit 降级未验证）。 */
  needHumanReview: boolean;
  /** 是否可直接使用（存在合法候选且置信度 ≥ 阈值，或公式类通过 Hill 记法校验且置信度达标）。 */
  usable: boolean;
  /** 实际使用的模型标识（provider/model）。 */
  modelUsed: string;
};
