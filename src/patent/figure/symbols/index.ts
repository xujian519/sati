/**
 * src/patent/figure/symbols — 电学符号知识库 barrel。
 */
export {
  ELECTRICAL_SYMBOL_CATEGORIES,
  ELECTRICAL_SYMBOL_CATEGORY_NAMES,
  type ElectricalSymbolCategory,
  type ElectricalSymbolEntry,
  type ElectricalSymbolIndex,
} from "./types.js";

export {
  loadElectricalSymbols,
  querySymbolByRefPrefix,
  querySymbolById,
  parseRefNumber,
  formatSymbolsAsContext,
} from "./loader.js";
