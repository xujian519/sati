/**
 * src/patent/argument — 论证结构互操作层（三向指针 + 统一缺口）。
 */

export type { ArgumentGap, ArgumentGapSource, ArgumentRef } from "./types.js";
export {
  ArgumentRefError,
  argumentRefKey,
  assertArgumentRef,
  dedupeArgumentGaps,
  normalizeArgumentRef,
} from "./refs.js";
export {
  claimChartGapsToArgumentGaps,
  syllogismErrorToArgumentGap,
  unbackedClaimsToArgumentGaps,
} from "./adapters.js";
