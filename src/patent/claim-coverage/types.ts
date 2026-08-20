/**
 * claim-coverage 协议层：权利要求-实施例覆盖矩阵的数据契约。
 *
 * 矩阵是撰写链路的预检产物（方案 §4.2）：把 draft-claims 产出的权利要求
 * 逐权项映射到交底书中的实施例，供 draft-spec 校验"每个特征都有实施例支撑"。
 * coverage/uncoveredFeatures 由 mapper 原子填写；checkClaimEmbodimentCoverage
 * 纯函数只信任 features + embodimentRefs 两列做确定性判定。
 */

/** 覆盖等级：full=有实施例引用；none=无任何实施例引用；partial 预留给 feature 级映射扩展。 */
export type ClaimCoverageLevel = "full" | "partial" | "none";

/** 单个权利要求的覆盖条目。 */
export type ClaimCoverageEntry = {
  /** 稳定编号，如 "claim_1"；格式：claim_<数字>（编号连续性校验）。 */
  claimId: string;
  /** 该权利要求的技术特征（LLM 从 claims_draft 抽取，供校验锚定）。 */
  features: string[];
  /** 实施例编号（"embodiment_1"），与骨架解析集合交叉校验。 */
  embodimentRefs: string[];
  /** 覆盖等级（mapper 推导）。 */
  coverage: ClaimCoverageLevel;
  /** 无实施例支撑的特征（mapper 推导；纯函数不信任此列，自行重算）。 */
  uncoveredFeatures: string[];
};

/** 覆盖矩阵（一次 LLM 结构化抽取的完整产物）。 */
export type ClaimEmbodimentCoverage = {
  caseId: string;
  claims: ClaimCoverageEntry[];
  /** LLM 抽取重试耗尽后降级（fail-open，不阻断管线）。 */
  degraded: boolean;
};

/** 确定性校验结果（纯函数产出，供单测与 draft-spec 消费）。 */
export type CoverageCheckResult = {
  /** 无实施例支撑的特征（claim 无任何 embodimentRefs 时整权项特征列入）。 */
  missingEmbodiment: Array<{ claimId: string; feature: string }>;
  /** 编号非法或断裂（claim_1 → claim_3 缺 claim_2 时列出缺失编号）。 */
  badClaimIds: string[];
  /** 跨权利要求重复特征（提示性，不判失败）。 */
  duplicateFeatures: string[];
};
