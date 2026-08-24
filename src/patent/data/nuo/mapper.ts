/**
 * src/patent/data/nuo — nuo-patent 数据引擎适配层。
 *
 * nuo-patent 的 PatentData 中 inventor/assignee/classifications/引证等字段按
 * 历史约定存储为 JSON 字符串（Python 原版继承）。本层负责将其映射为
 * Sati 内部使用的结构化类型，供内置工具与检索 provider 消费。
 */

import type { Citation, PatentData } from "nuo-patent";

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

/** 宽容解析 JSON 数组字符串；空/非法输入返回空数组（不抛异常）。 */
export function parseJsonArray<T>(raw: string): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    // 非法 JSON 数组字符串：返回空数组，避免单条坏数据拖垮整条专利映射。
    return [];
  }
}

/** 从 `[{"inventor_name": "..."}]` 形式提取字符串数组。 */
function extractNames(raw: string, key: "inventor_name" | "assignee_name"): string[] {
  return parseJsonArray<Record<string, unknown>>(raw)
    .map(item => (typeof item[key] === "string" ? item[key] : ""))
    .filter(Boolean);
}

/** 把 nuo-patent PatentData（含 JSON 字符串字段）映射为结构化类型。 */
export function mapPatentData(data: PatentData, patent: string, url: string): StructuredPatentData {
  const backwardCites = [
    ...parseJsonArray<Citation>(data.backward_cite_no_family),
    ...parseJsonArray<Citation>(data.backward_cite_yes_family),
  ];
  const forwardCites = [
    ...parseJsonArray<Citation>(data.forward_cite_no_family),
    ...parseJsonArray<Citation>(data.forward_cite_yes_family),
  ];

  return {
    patent,
    url,
    title: data.title,
    applicationNumber: data.application_number,
    inventors: extractNames(data.inventor_name, "inventor_name"),
    assigneesOriginal: extractNames(data.assignee_name_orig, "assignee_name"),
    assigneesCurrent: extractNames(data.assignee_name_current, "assignee_name"),
    pubDate: data.pub_date,
    filingDate: data.filing_date,
    priorityDate: data.priority_date,
    grantDate: data.grant_date,
    expirationDate: data.expiration_date,
    legalStatus: data.legal_status,
    ifiStatus: data.ifi_status,
    estimatedExpiration: data.estimated_expiration,
    pdfUrl: data.pdf_url,
    classifications: parseJsonArray<string>(data.classifications),
    backwardCites,
    forwardCites,
    abstractText: data.abstract_text,
  };
}
