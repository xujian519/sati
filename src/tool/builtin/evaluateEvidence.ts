import {
  createSpan,
  loadEvidenceRulesEngine,
  type EvidenceDirection,
  type EvidenceExternalInputs,
  type EvidenceType,
  type EvidenceJudgmentEngine,
} from "../../patent/index.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type EvaluateEvidenceInput = {
  /** 待判定证据描述（原文摘录；使用公开四要件据此识别）。 */
  snippet: string;
  /** 来源 URI（web:https:// / patent:CN… / file:// 等；判定平台可信度与类型）。 */
  sourceUri?: string;
  /** 证据日期（页面标注公开日/使用公开主张日，多格式：2023-01-02 / 2023年1月 / 20230102）。 */
  docVersion?: string;
  /** 内容哈希（真实性/完整性校验；留空则视为不可校验）。 */
  contentHash?: string;
  /** 证据方向：supporting / contradicting / neutral。 */
  direction?: EvidenceDirection;
  /** 绑定的结论 id 列表（相关性判定加分项）。 */
  claimRefs?: string[];
  /** 显式证据类型（缺省按 sourceUri scheme 自动推断）。 */
  evidenceType?: EvidenceType;
  /** 专利申请日（公开日判定是否构成现有技术）。 */
  filingDate?: string;
  /** 案件类型（举证责任分配）：invalidation / infringement / new_product_method / 其他。 */
  caseType?: string;
  /** 外部输入：规则的不可判定条件（公证/译本/证人披露等）。 */
  notarized?: boolean;
  legalized?: boolean;
  translated?: boolean;
  witnessDisclosed?: boolean;
  isWellKnown?: boolean;
  isUncontested?: boolean;
  deadlineDefined?: boolean;
  submissionWithinDeadline?: boolean;
  /** 证据收集主体/程序/形式合法（EVI-002）。 */
  collectionLegal?: boolean;
  /** 支持性证据已计数（EVI-030 证明标准）。 */
  supportingCount?: number;
  /** 矛盾证据已计数（EVI-030 证明标准）。 */
  contradictingCount?: number;
  /** 证据保管链可追溯（EVI-050）。 */
  custodyChainTraceable?: boolean;
  /** 证据完整性已核验（EVI-050）。 */
  integrityVerified?: boolean;
};

export type EvaluateEvidenceOutput = {
  judgment: {
    spanId: string;
    overallScore: number;
    confidence: number;
    relevance: { score: number; level: string };
    legality: { score: number; level: string };
    authenticity: { score: number; level: string };
    typeSpecific?: Record<string, unknown>;
    flaggedIssues: Array<{ type: string; description: string; severity: string }>;
    reasoning: string;
  };
  burden?: { burdenHolder: string; standard: string; hasShifted: boolean; reasoning: string };
  /** 实际适用的证据规则（条件全部满足；不再返回全量表）。 */
  rulesMatched: Array<{ ruleId: string; name: string; action: string; severity: string }>;
  /** 待外部输入确认的规则（条件含未提供的输入）。 */
  rulesPending: Array<{ ruleId: string; name: string; pendingInputs: string[] }>;
};

/**
 * `evaluate_evidence` — 证据三性判定工具（移植自 Mady domains/evidence）。
 *
 * 对单条证据做确定性判定：三性评分（相关性/合法性/真实性，权重可经
 * rules/patent/evidence-rules.yaml 配置）+ 类型特定检查（电子证据平台可信度/
 * 互联网公开日期与完整性/使用公开四要件/域外公证/公知常识免证），
 * 并给出举证责任分配与**实际适用**的证据规则（rulesMatched）。
 * 只读、无副作用。引擎与规则资产在首次执行时惰性加载（不阻塞网关启动）。
 */
export function createEvaluateEvidenceTool(deps?: {
  engine?: EvidenceJudgmentEngine;
}): SatiToolDefinition<EvaluateEvidenceInput, EvaluateEvidenceOutput> {
  // 惰性加载：仅首次 execute 时加载资产（registry 构建/网关启动不支付文件 IO）
  let loadedEngine: EvidenceJudgmentEngine | undefined = deps?.engine;
  const resolveEngine = (): EvidenceJudgmentEngine => {
    loadedEngine ??= loadEvidenceRulesEngine().engine;
    return loadedEngine;
  };

  return {
    name: "evaluate_evidence",
    title: "Evaluate Evidence",
    description:
      "对专利证据做确定性三性判定（相关性/合法性/真实性）与类型特定检查（电子证据/互联网公开/使用公开四要件/域外证据/公知常识），" +
      "输出综合评分、举证责任分配与实际适用的证据规则。在 OA 答复、无效宣告论证引用证据前调用，可提前发现证据缺陷。",
    kind: "custom",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["snippet"],
      properties: {
        snippet: { type: "string", description: "待判定证据描述（原文摘录）。" },
        sourceUri: {
          type: "string",
          description:
            "来源 URI，如 web:https://example.com/page、patent:CN123、file:///path。判定平台可信度与证据类型。",
        },
        docVersion: { type: "string", description: "证据日期，如 2023-01-02、2023年1月、20230102、Jan 15, 2023。" },
        contentHash: { type: "string", description: "内容哈希（真实性/完整性校验）。" },
        direction: { type: "string", enum: ["supporting", "contradicting", "neutral"], description: "证据方向。" },
        claimRefs: { type: "array", items: { type: "string" }, description: "绑定的结论 id 列表。" },
        evidenceType: {
          type: "string",
          description: "显式证据类型（缺省按 sourceUri 推断）。",
          enum: [
            "general",
            "foreign_language",
            "overseas",
            "electronic",
            "witness_testimony",
            "expert_opinion",
            "common_knowledge",
            "notarial_certificate",
            "burden_of_proof",
            "standard_of_proof",
            "prior_art_date",
            "procedural",
            "internet_publication",
            "public_use",
            "design_comparison",
          ],
        },
        filingDate: { type: "string", description: "专利申请日（公开日是否早于申请日）。" },
        caseType: { type: "string", description: "案件类型：invalidation / infringement / new_product_method。" },
        notarized: { type: "boolean", description: "域外证据已公证（EVI-011 条件）。" },
        legalized: { type: "boolean", description: "域外证据已认证（EVI-011 条件）。" },
        translated: { type: "boolean", description: "外文证据已附中文译本（EVI-011 条件）。" },
        witnessDisclosed: { type: "boolean", description: "证人利害关系已披露（EVI-012 条件）。" },
        isWellKnown: { type: "boolean", description: "待证事实为公知常识（EVI-013 条件）。" },
        isUncontested: { type: "boolean", description: "待证事实无争议（EVI-013 条件）。" },
        deadlineDefined: { type: "boolean", description: "举证期限已定义（EVI-051 条件）。" },
        submissionWithinDeadline: { type: "boolean", description: "证据在期限内提交（EVI-051 条件）。" },
        collectionLegal: { type: "boolean", description: "证据收集主体/程序/形式合法（EVI-002 条件）。" },
        supportingCount: { type: "number", description: "支持性证据已计数（EVI-030 证明标准条件）。" },
        contradictingCount: { type: "number", description: "矛盾证据已计数（EVI-030 证明标准条件）。" },
        custodyChainTraceable: { type: "boolean", description: "证据保管链可追溯（EVI-050 条件）。" },
        integrityVerified: { type: "boolean", description: "证据完整性已核验（EVI-050 条件）。" },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const engine = resolveEngine();
      const span = createSpan({
        snippet: input.snippet,
        sourceUri: input.sourceUri,
        docVersion: input.docVersion,
        contentHash: input.contentHash,
        direction: input.direction ?? "neutral",
        claimRefs: input.claimRefs,
      });
      const external: EvidenceExternalInputs = {
        notarized: input.notarized,
        legalized: input.legalized,
        translated: input.translated,
        witnessDisclosed: input.witnessDisclosed,
        isWellKnown: input.isWellKnown,
        isUncontested: input.isUncontested,
        deadlineDefined: input.deadlineDefined,
        submissionWithinDeadline: input.submissionWithinDeadline,
        collectionLegal: input.collectionLegal,
        caseType: input.caseType,
        supportingCount: input.supportingCount,
        contradictingCount: input.contradictingCount,
        custodyChainTraceable: input.custodyChainTraceable,
        integrityVerified: input.integrityVerified,
      };
      const judgment = engine.judge(span, input.filingDate, input.evidenceType, external);
      const burden = input.caseType !== undefined ? engine.assessBurdenOfProof(input.caseType) : undefined;

      const output: EvaluateEvidenceOutput = {
        judgment: {
          spanId: judgment.spanId,
          overallScore: Number(judgment.overallScore.toFixed(3)),
          confidence: judgment.confidence,
          relevance: {
            score: judgment.relevanceJudgment?.score ?? 0,
            level: judgment.relevanceJudgment?.level ?? "low",
          },
          legality: {
            score: judgment.legalityJudgment?.score ?? 0,
            level: judgment.legalityJudgment?.level ?? "low",
          },
          authenticity: {
            score: judgment.authenticityJudgment?.score ?? 0,
            level: judgment.authenticityJudgment?.level ?? "low",
          },
          typeSpecific: judgment.typeSpecificJudgment as Record<string, unknown> | undefined,
          flaggedIssues: judgment.flaggedIssues,
          reasoning: judgment.reasoning,
        },
        burden,
        rulesMatched: judgment.rulesApplied
          .filter(r => r.satisfied)
          .map(r => ({ ruleId: r.ruleId, name: r.name, action: r.action, severity: r.severity })),
        rulesPending: judgment.rulesApplied
          .filter(r => r.pendingInputs.length > 0)
          .map(r => ({ ruleId: r.ruleId, name: r.name, pendingInputs: r.pendingInputs })),
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
      };
    },
  };
}
