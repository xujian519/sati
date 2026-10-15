/**
 * src/patent/fees — 中国专利官费计价（A4）。
 *
 * 从「有哪些费种、该不该缴」到「多少钱」的完整链路：
 *
 * - {@link ./fees.ts} 装载并校验随包费率资产（缺失/畸形一律 fail-loud）；
 * - {@link ./compute.ts} 对一个案子计价，金额按支持程度分级，合计只在全部已核验时给出；
 * - {@link ./report.ts} 渲染成可读的缴费清单；
 * - {@link ./money.ts} 金额算术（整数分，无浮点）。
 *
 * 费率资产在 `assets/patent/fees/cn-fees.yaml`；每一项金额都带抄录出处与核验日期，
 * 因为官费标准是**会被改**的文书（门槛、比例、费种都改过），照过期文书抄录会静默算错钱。
 */

export {
  clearFeeTableCache,
  EMPTY_TRIGGER_NOTES,
  emptyTriggerNote,
  FEE_BASES,
  FEE_FILE_NAME,
  FEE_TRIGGERS,
  FeeTableError,
  feeTablePath,
  loadFeeTable,
  parseFeeTable,
  PATENT_TYPE_LABELS,
  PATENT_TYPES,
  REDUCTION_KINDS,
} from "./fees.js";
export { computeFees, DEFAULT_FEE_POLICY, type ComputeOptions, type FeePolicy } from "./compute.js";
export { applyPercent, formatFen, parseYuan, reducedFen, sumFen } from "./money.js";
export { renderFeeReport, type FeeReportMeta } from "./report.js";
export type {
  AmountStatus,
  AnnuityTier,
  FeeBasis,
  FeeItem,
  FeeLine,
  FeeQuery,
  FeeReport,
  FeeTable,
  FeeTotal,
  FeeTrigger,
  FeeValueSource,
  LatePaymentRule,
  PatentType,
  PendingFee,
  ReductionKind,
  ReductionKindRule,
  ReductionOutcome,
  ReductionRequest,
} from "./types.js";
