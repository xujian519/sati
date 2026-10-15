/**
 * law_verify — 法条引用核验工具（交付前自检用）。
 *
 * 与 `law_search` 的分工：`law_search` 用来**找**法条，本工具用来**判**引用是否成立。
 * 数据源同为一个 knowledge.db（`doc_type='law_article'`），但索引与判定在
 * `law-index.ts` / `law-verify.ts`（现算，不依赖随包资产）。
 */

import type { SatiToolDefinition } from "../../tool/protocol/types.js";
import { resolveKnowledgeDbPaths } from "../config.js";
import { loadLawIndex, type LoadedLawIndex } from "./law-index.js";
import { DECISION_SEVERITY, verifyCitations, type CitationDecision, type CitationFinding } from "./law-verify.js";

export type LawVerifyToolInput = {
  /** 待核验文本（从其中抽取全部法条引用，如 OA 答复稿、意见书、权利要求书）。 */
  text: string;
  /** 可选：这些引用共同支持的命题，用于字面比对（不传则只核条号）。 */
  proposition?: string;
};

export type LawVerifyFindingOutput = {
  /** 引用原文。 */
  raw: string;
  law: string;
  article: number;
  decision: CitationDecision;
  /** 该判定对应的处置建议（block = 应拦截；warn = 提示；allow = 通过）。 */
  policy: "block" | "warn" | "allow";
  reason: string;
};

export type LawVerifyToolOutput = {
  total: number;
  blocked: number;
  findings: LawVerifyFindingOutput[];
  /** 索引概况（选源结果的摘要，便于复核"这次核的是哪一份"）。 */
  index: { laws: number; dbPath: string };
};

/** 工具描述里的能力边界（改判定逻辑时同步改这里——它是用户看到的那份）。 */
const DESCRIPTION = [
  "核验文本中的中国专利法条引用：条号是否存在、是否超出该法条数、命题是否与该条正文有共同表述。",
  "用于交付前自检（OA 答复、意见书、权利要求书里的法条引用）。",
  "",
  "⚠️ 这是**引用形式门禁**，不是命题正确性门禁，三条边界必须知道：",
  "1. 拦不住「条号与命题不符但共享常见法律词」——判据是命题与该条正文共享任一 3 字片段，",
  "   任何含「创造性」「权利要求」「申请人」等常见词的无关命题都会判通过。理由里会报出重合强度",
  "   （如「仅重合 1/17 个片段」），据此判断这次通过有多硬。",
  "2. `mismatch` 只在命题与该条**零**共同片段时触发，别指望它拦同义改写；",
  "   真正的 mismatch 更可能意味着引错了条，而不是措辞不同。",
  "3. 它证明「条号在库、条文里有这些字」，**不证明库里条文与官方文本逐字一致**。",
  "另：《专利审查指南》的章节引用、以及「A22.3」这类审查意见简写形态都不在核验范围内",
  "（库里的指南是规则卡片、没有章节路径体系；简写形态无可靠边界，硬匹配会误伤「A4纸」这类词）。",
].join("\n");

/** 截断过长的引用原文（避免报告行失控）。 */
function truncate(value: string, max = 60): string {
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

/** 把判定结果渲染成人读报告。 */
export function renderLawVerifyReport(output: LawVerifyToolOutput, proposition?: string): string {
  const lines: string[] = [];
  const blocked = output.findings.filter(finding => finding.policy === "block").length;
  lines.push(
    output.total === 0
      ? "未在文本中发现法条引用。"
      : `核验 ${output.total} 条引用：${blocked > 0 ? `**${blocked} 处需拦截**` : "无需拦截"}${blocked === output.total - blocked ? "" : ""}`,
  );
  if (proposition !== undefined && proposition.trim() !== "") lines.push(`命题：${truncate(proposition, 80)}`);
  for (const finding of output.findings) {
    const mark = finding.policy === "block" ? "⛔" : finding.policy === "warn" ? "⚠️" : "✓";
    lines.push(`${mark} ${finding.raw} → ${finding.decision}：${finding.reason}`);
  }
  if (output.total > 0 && blocked === 0 && output.findings.every(finding => finding.decision === "valid")) {
    lines.push("（以上仅说明条号成立；命题是否真被该条支撑须另行判断，见工具描述。）");
  }
  return lines.join("\n");
}

/** 把判定结果映射为工具输出。 */
export function toLawVerifyOutput(findings: CitationFinding[], dbPath: string, laws: number): LawVerifyToolOutput {
  const mapped: LawVerifyFindingOutput[] = findings.map(finding => ({
    raw: finding.raw,
    law: finding.reference.law,
    article: finding.reference.article,
    decision: finding.decision,
    policy: DECISION_SEVERITY[finding.decision],
    reason: finding.reason,
  }));
  return {
    total: mapped.length,
    blocked: mapped.filter(finding => finding.policy === "block").length,
    findings: mapped,
    index: { laws, dbPath },
  };
}

/**
 * 创建 `law_verify` 工具。
 *
 * `getIndexFn` 是注入点（测试可给假索引；生产走 `loadLawIndex`）。默认实现每次调用都
 * 重新构建索引——实测构建耗时约 15ms（60 部法 / 96 个文档），不值得为它维护缓存失效。
 */
export function createLawVerifyTool(
  getIndexFn: () => LoadedLawIndex | undefined = loadLawIndex,
): SatiToolDefinition<LawVerifyToolInput, LawVerifyToolOutput> {
  return {
    name: "law_verify",
    title: "Law Verify",
    description: DESCRIPTION,
    kind: "custom",
    domain: "legal",
    outputSchema: {
      type: "object",
      properties: {
        total: { type: "number" },
        blocked: { type: "number" },
        findings: { type: "array" },
        index: { type: "object" },
      },
      required: ["total", "blocked", "findings", "index"],
    },
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: {
          type: "string",
          description: "待核验文本；其中出现的法条引用会被逐条抽取并判定",
        },
        proposition: {
          type: "string",
          description:
            "可选：这些引用共同支持的命题（如「创造性要求突出的实质性特点和显著的进步」）。不传则只核条号是否成立",
        },
      },
      required: ["text"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const { knowledgeDb } = resolveKnowledgeDbPaths();
      if (knowledgeDb === undefined) {
        return {
          ok: false,
          code: "setup_required",
          reason: "未找到知识库（默认路径 ~/.sati/knowledge/knowledge.db，可用 SATI_KNOWLEDGE_DIR 指定）",
        };
      }
      return { ok: true };
    },
    execute: async (input: LawVerifyToolInput) => {
      // ⚠️ 降级约定：索引不可用时**必须**报错退出，绝不允许「没核成 → 当作没问题」。
      // 一次静默放行比没有核验更糟（调用方会以为自己已经核过了）。
      const loaded = getIndexFn();
      if (loaded === undefined) {
        return {
          content: [
            {
              type: "text",
              text: "错误：无法读取知识库，法条引用未经核验。请配置 SATI_KNOWLEDGE_DIR，或改用人工核对——不要把这当成「核验通过」。",
            },
          ],
          metadata: { error: "knowledge_db_unavailable" },
        };
      }

      const findings = verifyCitations(input.text, loaded.index, input.proposition);
      const output = toLawVerifyOutput(findings, loaded.dbPath, loaded.index.entries.size);
      return {
        content: [{ type: "text", text: renderLawVerifyReport(output, input.proposition) }],
        data: output,
        metadata: {
          domain: "legal",
          dbPath: loaded.dbPath,
          laws: loaded.index.entries.size,
          blocked: output.blocked,
        },
      };
    },
  };
}
