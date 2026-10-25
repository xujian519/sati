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
import { hasNoRequiredMetadata, mapPatentData } from "../../patent/data/nuo/mapper.js";

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
  /**
   * 页面结构变化导致字段缺失时为 true（部分缺失）；
   * 必需字段全空会抛错，不会以 success:true 返回。
   */
  degraded: boolean;
  degradedReason: string;
  /** 数据来源标记：当前仅 HTML microdata 解析路径 */
  dataSource: "html-microdata";
};

export type CreatePatentMetadataToolOptions = {
  /** 抓取函数注入（测试用；缺省用 nuo-patent 的 scrapePatent） */
  scrape?: typeof scrapePatent;
};

/** 把 nuo-patent 的 ScrapeResult 映射为工具输出或抛结构化错误。 */
function mapScrapeResult(result: Awaited<ReturnType<typeof scrapePatent>>): PatentMetadataOutput {
  if (result.success && result.data) {
    const data = mapPatentData(result.data, result.patent, result.url);
    // 页面整体不可解析时不再伪装成成功：必需字段（标题/发明人/受让人/申请日）全空
    // 只能说明解析器与页面结构脱节，模型必须看到错误而不是一串 N/A。
    if (hasNoRequiredMetadata(data)) {
      throw new SatiToolRuntimeError("tool_execution_failed", "PARSE_ERROR: 专利页面结构变化，必需字段全部解析失败", {
        tool: "patent_metadata",
        patent: result.patent,
        errorCode: "PARSE_ERROR",
        missingFields: data.missingFields,
      });
    }
    const degraded = data.missingFields.length > 0;
    return {
      success: true,
      patent: result.patent,
      url: result.url,
      data,
      errorCode: "",
      errorMessage: "",
      parseWarnings: result.parseWarnings,
      degraded,
      degradedReason: degraded ? `页面结构变化，字段不可用: ${data.missingFields.join(", ")}` : "",
      dataSource: "html-microdata",
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
        degraded: false,
        degradedReason: "",
        dataSource: "html-microdata",
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
      required: [
        "success",
        "patent",
        "url",
        "data",
        "errorCode",
        "errorMessage",
        "parseWarnings",
        "degraded",
        "degradedReason",
        "dataSource",
      ],
      properties: {
        success: { type: "boolean" },
        patent: { type: "string" },
        url: { type: "string" },
        data: {
          type: ["object", "null"],
          properties: {
            patent: { type: "string" },
            title: { type: "string" },
            inventors: { type: "array", items: { type: "string" } },
            assigneesOriginal: { type: "array", items: { type: "string" } },
            assigneesCurrent: { type: "array", items: { type: "string" } },
            filingDate: { type: "string" },
            grantDate: { type: "string" },
            legalStatus: { type: "string" },
            pdfUrl: { type: "string" },
            classifications: { type: "array", items: { type: "string" } },
            abstractText: { type: "string" },
            missingFields: { type: "array", items: { type: "string" } },
          },
        },
        errorCode: { type: "string" },
        errorMessage: { type: "string" },
        parseWarnings: {
          type: "array",
          items: {
            type: "object",
            required: ["field", "message"],
            properties: { field: { type: "string" }, message: { type: "string" } },
          },
        },
        degraded: { type: "boolean" },
        degradedReason: { type: "string" },
        dataSource: { type: "string", enum: ["html-microdata"] },
      },
    },
    aliases: ["PatentMetadata", "get_patent_metadata"],
    title: "Patent Metadata Lookup",
    description:
      "Fetch patent metadata from Google Patents by patent number (e.g. US11452699B2): title, inventors, " +
      "assignees, dates, legal status, estimated expiration, abstract, PDF URL, classifications, and citations. " +
      "Validates and normalizes the number. Read-only. Not-found is success:false data. Missing fields surface " +
      "via degraded/missingFields/parseWarnings instead of silent N/A.",

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
      if (output.degraded) {
        lines.push("", `⚠️ ${output.degradedReason}（页面结构变化，字段不可用）`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        data: output,
        metadata: {
          patent: d.patent,
          success: true,
          citationCount: d.backwardCites.length + d.forwardCites.length,
          degraded: output.degraded,
        },
      };
    },
  };
}
