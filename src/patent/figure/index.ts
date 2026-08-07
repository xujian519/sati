/**
 * src/patent/figure — 专利附图分析模块 barrel。
 *
 * 提供附图智能分析（VLM 两步法 + 电学 Step3 深度分析）、电学符号知识库、
 * 电学确定性校验、附图索引与检索的完整能力。
 */

export {
  FIGURE_TYPES,
  FIGURE_TYPE_NAMES,
  FIGURE_COMPONENT_KINDS,
  FIGURE_CONNECTION_KINDS,
  ELECTRICAL_CATEGORIES,
  normalizeFigureType,
  normalizeComponentKind,
  normalizeConnectionKind,
  normalizeElectricalCategory,
  type FigureType,
  type FigureComponentKind,
  type FigureConnectionKind,
  type ElectricalCategory,
  type FigureComponent,
  type FigureConnection,
  type ElectricalComponent,
  type ElectricalNet,
  type ElectricalAnalysis,
  type FigureAnalysisResult,
} from "./types.js";

export {
  FIGURE_SPEC_GUIDE,
  STEP1_SCHEMA,
  STEP2_SCHEMA,
  STEP3_SCHEMA,
  buildStep1Prompt,
  buildStep2Prompt,
  buildStep3Prompt,
  type Step1Result,
  type Step2Result,
  type Step3Result,
} from "./prompts.js";

export {
  DEFAULT_FIGURE_PROVIDER,
  DEFAULT_FIGURE_MODEL,
  analyzePatentFigure,
  buildFigureDescription,
  type FigureAnalyzerOptions,
  type FigureModelClient,
  type FigureAnalysisPhase,
  type AnalyzePatentFigureInput,
} from "./analyze.js";

export {
  analyzeElectricalFigure,
  type AnalyzeElectricalInput,
  type AnalyzeElectricalOptions,
} from "./analyze-electrical.js";

export {
  validateElectricalAnalysis,
  extractClaimRefs,
  type ElectricalValidationResult,
} from "./validator.js";

export {
  renderElectricalNetlistMermaid,
  renderElectricalNetlistSvg,
  formatElectricalSummary,
  mermaidId,
} from "./netlist-viz.js";

export {
  checkFigureConsistency,
  type FigureConsistencyReport,
  type ComponentConflict,
} from "./multi-figure-consistency.js";

export {
  extractPdfPages,
  extractPdfFigureCandidates,
  extractPdfPagesFromFile,
  renderPdfPageAsBase64,
  openPdfDocument,
  type PdfExtractOptions,
  type PdfExtractedPage,
  type PdfFigureCandidate,
  type PdfTextBlock,
} from "./pdf-extract.js";

export {
  ELECTRICAL_SYMBOL_CATEGORIES,
  ELECTRICAL_SYMBOL_CATEGORY_NAMES,
  type ElectricalSymbolCategory,
  type ElectricalSymbolEntry,
  type ElectricalSymbolIndex,
} from "./symbols/index.js";

export {
  loadElectricalSymbols,
  querySymbolByRefPrefix,
  querySymbolById,
  parseRefNumber,
  formatSymbolsAsContext,
} from "./symbols/index.js";

export { loadFigureImage, type PreparedFigure, DEFAULT_MAX_FIGURE_BYTES } from "./preprocess.js";

export {
  FIGURE_INDEX_VERSION,
  DEFAULT_FIGURE_INDEX_RELATIVE_PATH,
  loadFigureIndex,
  saveFigureIndex,
  upsertFigureIndex,
  type FigureIndexFile,
  type FigureIndexEntry,
} from "./index-store.js";

export {
  MAX_VECTOR_DOCS,
  HYBRID_KEYWORD_WEIGHT,
  HYBRID_VECTOR_WEIGHT,
  retrieveFigures,
  buildFigureDocumentText,
  tokenizeFigureText,
  type FigureRetrieveMethod,
  type FigureRetrieveHit,
  type FigureRetrieveResult,
  type FigureRetrieveOptions,
} from "./retrieve.js";
