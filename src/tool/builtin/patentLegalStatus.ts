/**
 * `patent_legal_status` 内置工具 — 批量查询专利法律状态与预估到期日。
 *
 * 数据引擎为 nuo-patent LegalStatusChecker（Google Patents IFI 法律状态解析，
 * 覆盖全球专利；CNIPA 中国专利事务查询不在此工具范围内）。
 * 只读、domain: patent、批量并发（默认 4），单专利失败不中断整体。
 */

import { LegalStatusChecker } from "nuo-patent";
import type { SatiToolDefinition } from "../protocol/types.js";

export type PatentLegalStatusInput = {
  /** 专利号列表（1-20 个），如 ["US11452699B2", "US2668287A"] */
  patents: string[];
  /** 最大并发数，默认 4 */
  maxConcurrency?: number;
};

export type PatentLegalStatusItem = {
  patentNumber: string;
  title: string;
  status: string;
  ifiStatus: string;
  estimatedExpiration: string;
  filingDate: string;
  grantDate: string;
  applicant: string;
  inventor: string;
  /** 最近事务/状态事件摘要 */
  events: Array<{ type: string; date: string; title: string }>;
  url: string;
  /** 单专利查询失败时的错误描述（不影响其他专利） */
  error?: string;
};

export type PatentLegalStatusOutput = {
  results: PatentLegalStatusItem[];
};

export type CreatePatentLegalStatusToolOptions = {
  /** 检查器注入（测试用；缺省用 nuo-patent 的 LegalStatusChecker） */
  checker?: LegalStatusChecker;
};

const MAX_PATENTS = 20;

export function createPatentLegalStatusTool(
  options?: CreatePatentLegalStatusToolOptions,
): SatiToolDefinition<PatentLegalStatusInput, PatentLegalStatusOutput> {
  const checker = options?.checker ?? new LegalStatusChecker();

  return {
    name: "patent_legal_status",
    aliases: ["PatentLegalStatus", "patent_status"],
    title: "Patent Legal Status",
    description: [
      "- Queries patent legal status (Active / Expired / Abandoned) and estimated expiration from Google Patents",
      "- Batch: pass 1-20 patent numbers; individual failures are reported per-patent without aborting the batch",
      "- Returns title, status, estimated expiration, filing/grant dates, applicant, inventor, and status event history",
      "",
      "Usage notes:",
      "  - Read-only; makes one network request per patent (concurrency 4 by default)",
      "  - For CNIPA (China) legal-status transactions use the cnipa-query skill instead",
    ].join("\n"),
    kind: "network",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["patents"],
      additionalProperties: false,
      properties: {
        patents: {
          type: "array",
          items: { type: "string" },
          description: "Patent numbers (1-20), e.g. ['US11452699B2', 'US2668287A']",
          minItems: 1,
          maxItems: MAX_PATENTS,
        },
        maxConcurrency: {
          type: "number",
          description: "Max concurrent requests (default 4)",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input, context) => {
      const patents = input.patents.slice(0, MAX_PATENTS);
      const results = await checker.checkBatch(patents, {
        signal: context.abortSignal,
        maxConcurrency: input.maxConcurrency ?? 4,
      });

      const items: PatentLegalStatusItem[] = patents.map(pn => {
        const r = results[pn];
        if (!r) {
          return {
            patentNumber: pn,
            title: "",
            status: "UNKNOWN",
            ifiStatus: "",
            estimatedExpiration: "",
            filingDate: "",
            grantDate: "",
            applicant: "",
            inventor: "",
            events: [],
            url: "",
            error: "查询结果缺失",
          };
        }
        return {
          patentNumber: r.patent_number,
          title: r.title,
          status: r.status,
          ifiStatus: r.ifi_status,
          estimatedExpiration: r.estimated_expiration,
          filingDate: r.filing_date,
          grantDate: r.grant_date,
          applicant: r.applicant,
          inventor: r.inventor,
          events: r.events_summary,
          url: r.url,
          error: r.error,
        };
      });

      const lines = items.map(item => {
        const flag = item.error ? "❌" : item.status === "UNKNOWN" ? "⚠️" : "✅";
        const exp = item.estimatedExpiration ? ` · expires ${item.estimatedExpiration}` : "";
        return `- ${flag} ${item.patentNumber}: ${item.title || item.error || "未知状态"} (${item.status || "UNKNOWN"})${exp}`;
      });

      return {
        content: [
          {
            type: "text",
            text: [`patent_legal_status: ${items.length} result(s)`, "", lines.join("\n")].join("\n"),
          },
        ],
        data: { results: items },
        metadata: { count: items.length, withError: items.filter(i => i.error).length },
      };
    },
  };
}
