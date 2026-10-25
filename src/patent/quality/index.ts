/**
 * src/patent/quality — 撰写流程确定性质量门 barrel。
 */
export {
  checkSearchQuality,
  resolveSearchQualityThresholds,
  MIN_DOCS,
  MIN_RELATEDNESS_MARKS,
  MIN_FULLTEXT_MARKS,
  SINGLE_SOURCE_MIN_DOCS,
  SINGLE_SOURCE_MIN_FULLTEXT_MARKS,
  MULTI_SOURCE_THRESHOLDS,
  SINGLE_SOURCE_THRESHOLDS,
  type SearchQualityOptions,
  type SearchQualityResult,
  type SearchQualityThresholds,
} from "./searchQuality.js";
