/**
 * EvidenceSpan 证据实体（移植自 Mady agentcore/evidence/span.go 设计）。
 *
 * 一条"证据" = 可定位、可校验、带方向性的原文切片：
 *   - 定位：DocVersion + PageRange + CharRange（文档版本/页码/字符区间）
 *   - 校验：ContentHash（原文完整性）
 *   - 语义：Direction（supporting/contradicting/neutral）——直接支撑冲突检测
 *           与"无证据支持"标记（UnbackedClaims）
 *   - 溯源：ReceiptID + TurnID + SourceURI（由哪个工具调用、来自哪里）
 *
 * 设计原则：任何结论都可绑定证据；无证据支持的结论被显式标记，
 * 而非当作事实陈述（对齐 Mady"证据驱动"产品主张）。
 */

export type EvidenceDirection = "supporting" | "contradicting" | "neutral";

export type EvidenceSpan = {
  /** 全局唯一 id */
  id: string;
  /** 收集时的 Agent 轮次 */
  turnId?: string;
  /** 产生该证据的工具调用收据 id（工具账本） */
  receiptId?: string;
  /** 文档版本："v1.0" / 日期 / 内容哈希前缀 */
  docVersion?: string;
  /** "第3页第15-20行" */
  pageRange?: string;
  /** "1200-1250" */
  charRange?: string;
  /** 原文完整性校验（内容哈希） */
  contentHash?: string;
  /** 原文摘录 */
  snippet?: string;
  /** 来源 URI：file:/// patent:CN123 web:https:// */
  sourceUri?: string;
  retrievalAt?: string;
  /** 证据方向：支持/矛盾/中性 */
  direction: EvidenceDirection;
  /** 支持的结论 id（由 ClaimBinding 维护，可空） */
  claimRefs?: string[];
};

export type CreateSpanInput = Omit<EvidenceSpan, "id"> & {
  id?: string;
};

/** 工厂：缺省生成 id（简短随机）。四元组定位信息至少保留一项（可校验）。 */
export function createSpan(input: CreateSpanInput, uuid: () => string = defaultUuid): EvidenceSpan {
  return {
    ...input,
    id: input.id ?? uuid(),
  };
}

function defaultUuid(): string {
  return `span-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 证据是否具备可定位信息（四元组任一即可，否则视为"不可定位证据"）。 */
export function isLocatable(span: EvidenceSpan): boolean {
  return Boolean(span.docVersion || span.pageRange || span.charRange || span.contentHash || span.sourceUri);
}
