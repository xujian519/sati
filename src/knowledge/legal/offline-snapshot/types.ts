/**
 * 离线法条快照格式（assets/legal-snapshot/manifest.json + *.jsonl.gz）。
 *
 * 快照是 law_search 的**兜底**数据源，不是第二事实源：在线索引（knowledge.db /
 * laws-full.db）存在且可读时优先，快照只在两者都不可用时启用，并在每条结果上
 * 显式标注 source=offline 与快照时点。
 */

/** 快照格式版本：字段含义变化时 +1；读端不匹配即拒绝（降级可见，不静默兼容）。 */
export const LEGAL_SNAPSHOT_SCHEMA_VERSION = 1;

export const LEGAL_SNAPSHOT_MANIFEST_FILE = "manifest.json";
export const LEGAL_SNAPSHOT_DATA_FILE = "legal-articles.jsonl.gz";

/** 快照清单（构建脚本 scripts/build-legal-snapshot.mjs 产出）。 */
export type LegalSnapshotManifest = {
  schemaVersion: number;
  /** 快照构建时点（YYYY-MM-DD），随结果回传给调用方与模型。 */
  snapshotAt: string;
  source: string;
  license: string;
  format: string;
  file: string;
  lawCount: number;
  articleCount: number;
  byteSize: number;
  sha256: string;
  /**
   * 未纳入快照的源文件统计（如未转录正文的条目）。只存计数/原因分布/少量样例：
   * 源端 7911 个文件里 7893 个 `text` 为空，逐文件清单会让 manifest 涨到 1MB 级。
   */
  skipped?: {
    count: number;
    reasons: Record<string, number>;
    samples?: Array<{ file: string; reason: string }>;
  };
};

/**
 * 快照中的一部法律。
 *
 * 紧凑键名（n/d/a/s/v）为压缩体积；语义固定如下：
 * - n: 法名（citation 用名，如 "专利法"）
 * - d: 文档名（正式名，如 "中华人民共和国专利法"）
 * - a: 条文列表 [条号, 正文]
 * - s?: 统一转录出处（同法一致时才有）
 * - v?: 统一核验日期（同法一致时才有）
 */
export type LegalSnapshotLaw = {
  n: string;
  d: string;
  a: Array<[number, string]>;
  s?: string;
  v?: string;
};

/** 快照不可用（缺失 / 损坏 / schema 不符）——构造期抛出，调用方据此降级。 */
export class LegalSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LegalSnapshotError";
  }
}
