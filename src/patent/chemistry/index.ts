/**
 * src/patent/chemistry — 化学式识别模块 barrel。
 *
 * 提供 L1 基础层全部能力：文本候选提取、RDKit 校验/规范化、VLM 识别
 * （图片两步法 / 名称转换 / 文本三级流水线）与识别索引持久化。
 */

export {
  CHEMICAL_KINDS,
  type ChemicalKind,
  type ChemicalSmilesCandidate,
  type ChemicalStructureResult,
} from "./types.js";

export {
  loadRdkitModule,
  isRdkitAvailable,
  formulaFromInChI,
  countElementsFromSmiles,
  isPlausibleSmilesSyntax,
  validateSmiles,
  type SmilesValidationResult,
} from "./smiles.js";

export {
  extractFormulaCandidates,
  extractSmilesCandidates,
  extractChemicalCandidates,
  isValidHillFormula,
} from "./text.js";

export {
  CHEMISTRY_SPEC_GUIDE,
  buildStep1Prompt,
  buildStep2Prompt,
  buildNameToSmilesPrompt,
  buildTextReviewPrompt,
  type Step1Result,
  type StructureResult,
  type TextReviewResult,
} from "./prompts.js";

export {
  DEFAULT_CHEMISTRY_PROVIDER,
  DEFAULT_CHEMISTRY_MODEL,
  CHEMISTRY_MIN_CONFIDENCE,
  analyzeChemicalImage,
  analyzeChemicalName,
  analyzeChemicalText,
  recognizeChemicalStructure,
  type ChemistryAnalyzerOptions,
  type ChemistryModelClient,
  type ChemistryPhase,
  type ChemicalImageInput,
} from "./analyze.js";

export {
  CHEMISTRY_INDEX_VERSION,
  DEFAULT_CHEMISTRY_INDEX_RELATIVE_PATH,
  loadChemistryIndex,
  saveChemistryIndex,
  upsertChemistryIndex,
  type ChemistryIndexEntry,
  type ChemistryIndexFile,
  type LoadChemistryIndexResult,
} from "./index-store.js";
