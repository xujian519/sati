/**
 * src/patent/clarity — 交底书清晰度准入（机械层 + 融合评分）。
 *
 * - signals.ts：四维结构信号检测（确定性正则）
 * - score.ts：语义分 × 机械信号融合、模糊度计算、门判定
 * - 语义层（LLM 四维打分）与 HITL 门语义在 atoms/handlers/builtin/clarity.ts
 */

export {
  detectClaritySignals,
  signalFor,
  type ClaritySignal,
  type ClaritySignalKey,
} from "./signals.js";
export {
  CLARITY_DIMENSIONS,
  CLARITY_THRESHOLD,
  SIGNAL_WEIGHT,
  computeClarityScore,
  formatSignalsForPrompt,
  type ClarityDimension,
  type ClarityDimensionKey,
  type ClarityScore,
} from "./score.js";
