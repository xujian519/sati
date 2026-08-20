/**
 * claim-coverage（权利要求-实施例覆盖矩阵）barrel。
 *
 * 对齐 claim-chart 先例：模块自带 index.ts，不进入 src/patent/index.ts
 * （消费方按子路径导入；mapper 原子接入 registerBuiltinAtoms 时再统一接线）。
 */

export type {
  ClaimCoverageLevel,
  ClaimCoverageEntry,
  ClaimEmbodimentCoverage,
  CoverageCheckResult,
} from "./types.js";
export { checkClaimEmbodimentCoverage } from "./coverage-check.js";
export { extractEmbodimentIds } from "./skeleton.js";
