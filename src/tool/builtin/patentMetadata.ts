/**
 * `patent_metadata` 内置工具 — 按专利号获取 Google Patents 元数据。
 *
 * 数据引擎为 nuo-patent（TS 原生，ego-browser 反爬优先，回退 fetch/代理隧道）。
 * 参照 literature `paper_search` 模式：只读、domain: patent、结构化输出，
 * 源错误（网络/超时/解析）抛结构化 SatiToolRuntimeError 与"专利不存在"天然区分。
 */

import { scrapePatent, validatePatentNumber } from "nuo-patent";
import { cachedScrapePatent } from "../../patent/data/nuo/patentCache.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition } from "../protocol/types.js";
import type { StructuredPatentData } from "../../patent/data/nuo/mapper.js";
import { mapPatentData } from "../../patent/data/nuo/mapper.js";

export type PatentMetadataInput = {
  /** 专利号，如 "US11452699B2"（自动校验并规范化） */
  patent: string;
  /** 请求超时（毫秒），默认 30000 */
  timeout?: number;
  /** 是否提取摘要，默认 true */
  returnAbstract?: boolean;
  /** 是否提取法律状态，默认 true */
  returnLegal?: boolean;
};

export type PatentMetadataOutput = {
  success: boolean;
  patent: string;
  url: string;
  /** 成功时为结构化专利数据（JSON 字符串字段已解析） */
  data: StructuredPatentData | null;
  /** 失败错误码（成功时为空串） */
  errorCode: string;
  errorMessage: string;
  /** 非致命解析警告（页面结构变化导致的字段缺失） */
  parseWarnings: Array<{ field: string; message: string }>;
};

export type CreatePatentMetadataToolOptions = {
  /** 抓取函数注入（测试用；缺省用 nuo-patent 的 scrapePatent） */
  scrape?: typeof scrapePatent;
};

/** 把 nuo-patent 的 ScrapeResult 映射为工具输出或抛结构化错误。 */
function mapScrapeResult(result: Awaited<ReturnType<typeof scrapePatent>>): PatentMetadataOutput {
  if (result.success && result.data) {
    return {
      success: true,
      patent: result.patent,
      url: result.url,
      data: mapPatentData(result.data, result.patent, result.url),
      errorCode: "",
      errorMessage: "",
      parseWarnings: result.parseWarnings,
    };
  }

  // 失败路径按错误码分类：可恢复运行时错误抛 SatiToolRuntimeError，
  // "专利不存在"等确定性结果作为结构化数据返回（与 paper_search 的"无结果"语义一致）。
  switch (result.errorCode) {
    case "VALIDATION_ERROR":
      throw new SatiToolRuntimeError("invalid_tool_input", result.errorMessage, {
        tool: "patent_metadata",
        patent: result.patent,
      });
    case "TIMEOUT":
      throw new SatiToolRuntimeError("tool_timeout", result.errorMessage, {
        tool: "patent_metadata",
        patent: result.patent,
      });
    case "NOT_FOUND":
      return {
        success: false,
        patent: result.patent,
        url: result.url,
        data: null,
        errorCode: result.errorCode,
        errorMessage: result.errorMessage,
        parseWarnings: result.parseWarnings,
      };
    default:
      throw new SatiToolRuntimeError("tool_execution_failed", result.errorMessage, {
        tool: "patent_metadata",
        patent: result.patent,
        errorCode: result.errorCode,
      });
  }
}

export function createPatentMetadataTool(
  options?: CreatePatentMetadataToolOptions,
): SatiToolDefinition<PatentMetadataInput, PatentMetadataOutput> {
  // 默认实现包 LRU 缓存 + 并发合并：同一专利号在 TTL 内重复点查直接命中，
  // 不再重复 spawn ego-browser / 抓 Google Patents。测试注入的 mock 原样使用。
  const scrape = options?.scrape ? options.scrape : cachedScrapePatent(scrapePatent);

  return {
    name: "patent_metadata",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentMetadata", "get_patent_metadata"],
    title: "Patent Metadata Lookup",
    description: [
      "- Fetches patent metadata from Google Patents by patent number (e.g. US11452699B2)",
      "- Returns structured data: title, inventors, assignees, dates, legal status, estimated expiration, abstract, PDF URL, classifications, citations",
      "- Validates and normalizes the patent number automatically",
      "- Use for patent due diligence, prior-art detail lookup, legal status checks",
      "",
      "Usage notes:",
      "  - Read-only; makes one network request per patent",
      "  - A 'not found' result (patent does not exist) is returned as data with success:false — not an error",
      "  - Non-fatal parse warnings are surfaced in parseWarnings when the page structure changes",
    ].join("\n"),
    kind: "network",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["patent"],
      additionalProperties: false,
      properties: {
        patent: {
          type: "string",
          description: "Patent number, e.g. 'US11452699B2'. Validated and normalized (uppercase, no spaces).",
        },
        timeout: {
          type: "number",
          description: "Request timeout in ms (default 30000)",
        },
        returnAbstract: {
          type: "boolean",
          description: "Include abstract (default true)",
        },
        returnLegal: {
          type: "boolean",
          description: "Include legal status (default true)",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    execute: async (input, context) => {
      const validation = validatePatentNumber(input.patent);
      if (!validation.valid) {
        throw new SatiToolRuntimeError(
          "invalid_tool_input",
          validation.reason ?? `Invalid patent number: ${input.patent}`,
          { tool: "patent_metadata", patent: input.patent },
        );
      }

      const result = await scrape(validation.normalized ?? input.patent, {
        timeout: input.timeout ?? 30000,
        returnAbstract: input.returnAbstract ?? true,
        returnLegal: input.returnLegal ?? true,
        signal: context.abortSignal,
      });

      const output = mapScrapeResult(result);

      if (!output.success) {
        return {
          content: [
            {
              type: "text",
              text: `patent_metadata(${output.patent}): ${output.errorMessage}`,
            },
          ],
          data: output,
          metadata: { patent: output.patent, success: false, errorCode: output.errorCode },
        };
      }

      const d = output.data!;
      const lines = [
        `## ${d.title}`,
        `**patent**: ${d.patent} · **url**: ${d.url}`,
        `**inventors**: ${d.inventors.join(", ") || "N/A"}`,
        `**assignees**: ${d.assigneesCurrent.join(", ") || "N/A"}`,
        `**dates**: filing ${d.filingDate || "N/A"} · grant ${d.grantDate || "N/A"} · pub ${d.pubDate || "N/A"}`,
        `**legal status**: ${d.legalStatus || "N/A"}${d.estimatedExpiration ? ` · est. expiration ${d.estimatedExpiration}` : ""}`,
        `**classifications**: ${d.classifications.join(", ") || "N/A"}`,
        `**citations**: ${d.backwardCites.length} backward · ${d.forwardCites.length} forward`,
      ];
      if (d.pdfUrl) lines.push(`**pdf**: ${d.pdfUrl}`);
      if (d.abstractText) lines.push("", d.abstractText);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        data: output,
        metadata: { patent: d.patent, success: true, citationCount: d.backwardCites.length + d.forwardCites.length },
      };
    },
  };
}
