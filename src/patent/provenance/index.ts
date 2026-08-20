/**
 * src/patent/provenance — 决策溯源层 barrel。
 *
 * 对齐 claim-chart 先例：模块自带 index.ts，接入点（collector/approval-store/export）
 * 随 Phase 1 各任务逐步加入，不预先暴露未实现面。
 */

export type {
  ProvenanceActivity,
  ProvenanceAgent,
  ProvenanceEntity,
  ProvenanceSource,
} from "./types.js";
export { ProvenanceStore } from "./provenance-store.js";
