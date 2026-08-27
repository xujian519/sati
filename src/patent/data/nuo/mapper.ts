/**
 * src/patent/data/nuo — nuo-patent 数据引擎适配层。
 *
 * nuo-patent 的 PatentData 中 inventor/assignee/classifications/引证等字段按
 * 历史约定存储为 JSON 字符串（Python 原版继承）。本层负责将其映射为
 * Sati 内部使用的结构化类型，供内置工具与检索 provider 消费。
 */

import type { Citation, PatentData } from "nuo-patent";
import { createLogger } from "../../../telemetry/index.js";

const logger = createLogger("nuo-mapper");

/** 非法 JSON 样本截断长度（含去空白后的单行样本）。 */
const BAD_JSON_SAMPLE_LEN = 80;

/** 单个坏 JSON 字段的诊断信息（供告警/测试注入）。 */
export type JsonParseDiagnostic = { field: string; sample: string };

/** 默认告警实现：结构化 logger.warn（含字段名+截断样本），不再静默吞错。 */
function defaultWarn(diag: JsonParseDiagnostic): void {
  logger.warn(`bad patent metadata JSON field "${diag.field}": ${diag.sample}`);
}

/** 结构化后的专利元数据（JSON 字符串字段已解析为数组/对象）。 */
export interface StructuredPatentData {
  patent: string;
  url: string;
  title: string;
  applicationNumber: string;
  inventors: string[];
  assigneesOriginal: string[];
  assigneesCurrent: string[];
  pubDate: string;
  filingDate: string;
  priorityDate: string;
  grantDate: string;
  expirationDate: string;
  legalStatus: string;
  ifiStatus: string;
  estimatedExpiration: string;
  pdfUrl: string;
  classifications: string[];
  backwardCites: Citation[];
  forwardCites: Citation[];
  abstractText: string;
}

/** 宽容解析 JSON 数组字符串；空/非法输入返回空数组（不抛异常）。
 * `field` 用于告警定位（vendor 字段漂移时可读）；`onError` 可注入（测试用），
 * 缺省走结构化 logger.warn——不再静默吞掉坏数据，防止字段漂移被掩盖。 */
export function parseJsonArray<T>(
  raw: string,
  field = "",
  onError: (diag: JsonParseDiagnostic) => void = defaultWarn,
): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // 非法 JSON 数组字符串：告警并返回空数组，避免单条坏数据拖垮整条专利映射。
    onError({ field, sample: truncateSample(raw) });
    return [];
  }
}

/** 压缩空白并把样本截断到 BAD_JSON_SAMPLE_LEN，避免长样本撑爆告警日志。 */
function truncateSample(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ");
  return collapsed.length > BAD_JSON_SAMPLE_LEN ? `${collapsed.slice(0, BAD_JSON_SAMPLE_LEN)}…` : collapsed;
}

/** 从 `[{"inventor_name": "..."}]` 形式提取字符串数组。 */
function extractNames(raw: string, key: "inventor_name" | "assignee_name", field: string): string[] {
  return parseJsonArray<Record<string, unknown>>(raw, field)
    .map(item => (typeof item[key] === "string" ? item[key] : ""))
    .filter(Boolean);
}

/** 把 nuo-patent PatentData（含 JSON 字符串字段）映射为结构化类型。 */
export function mapPatentData(data: PatentData, patent: string, url: string): StructuredPatentData {
  const backwardCites = [
    ...parseJsonArray<Citation>(data.backward_cite_no_family, "backward_cite_no_family"),
    ...parseJsonArray<Citation>(data.backward_cite_yes_family, "backward_cite_yes_family"),
  ];
  const forwardCites = [
    ...parseJsonArray<Citation>(data.forward_cite_no_family, "forward_cite_no_family"),
    ...parseJsonArray<Citation>(data.forward_cite_yes_family, "forward_cite_yes_family"),
  ];

  return {
    patent,
    url,
    title: data.title,
    applicationNumber: data.application_number,
    inventors: extractNames(data.inventor_name, "inventor_name", "inventor_name"),
    assigneesOriginal: extractNames(data.assignee_name_orig, "assignee_name", "assignee_name_orig"),
    assigneesCurrent: extractNames(data.assignee_name_current, "assignee_name", "assignee_name_current"),
    pubDate: data.pub_date,
    filingDate: data.filing_date,
    priorityDate: data.priority_date,
    grantDate: data.grant_date,
    expirationDate: data.expiration_date,
    legalStatus: data.legal_status,
    ifiStatus: data.ifi_status,
    estimatedExpiration: data.estimated_expiration,
    pdfUrl: data.pdf_url,
    classifications: parseJsonArray<string>(data.classifications, "classifications"),
    backwardCites,
    forwardCites,
    abstractText: data.abstract_text,
  };
}
