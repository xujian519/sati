// dream-review 的文本/详情渲染（从 dream-review.ts 拆出，G4 聚类，逐字搬移）。
// 注意 detail 的 decode:false 契约：dream 数据源已预解码，与 heartbeat/reasoning-loop
// 的解码语义不同；truncate 是"截断后 trim 并追加省略号"（与 utils/text.ts 默认不同）。
import type { MemoryManifestEntry, ProjectMetaRecord, RetrievalTraceDetail, TraceI18nText } from "../types.js";
import {
  jsonDetail as jsonDetailBase,
  kvDetail as kvDetailBase,
  listDetail as listDetailBase,
} from "../utils/detail.js";
import { truncate as truncateBase } from "../utils/text.js";

function kvDetail(
  key: string,
  label: string,
  entries: Array<{ label: string; value: unknown }>,
  labelI18n?: TraceI18nText,
): RetrievalTraceDetail {
  return kvDetailBase(key, label, entries, labelI18n, { decode: false });
}

function listDetail(key: string, label: string, items: string[], labelI18n?: TraceI18nText): RetrievalTraceDetail {
  return listDetailBase(key, label, items, labelI18n, { decode: false });
}

function jsonDetail(key: string, label: string, json: unknown, labelI18n?: TraceI18nText): RetrievalTraceDetail {
  return jsonDetailBase(key, label, json, labelI18n, { decode: false });
}

function truncate(value: string, maxLength: number): string {
  return truncateBase(value, maxLength, { trim: true });
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function previewMarkdown(markdown: string, maxLength = 220): string {
  return truncate(
    markdown
      .replace(/^#+\s+/gm, "")
      .replace(/\s+/g, " ")
      .trim(),
    maxLength,
  );
}

function sortEntries(entries: MemoryManifestEntry[]): MemoryManifestEntry[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.relativePath.localeCompare(right.relativePath);
  });
}

function sortProjectMetas(entries: ProjectMetaRecord[]): ProjectMetaRecord[] {
  return [...entries].sort((left, right) => {
    if (right.updatedAt !== left.updatedAt) return right.updatedAt.localeCompare(left.updatedAt);
    return left.projectName.localeCompare(right.projectName);
  });
}

export {
  jsonDetail,
  kvDetail,
  listDetail,
  normalizeWhitespace,
  previewMarkdown,
  sortEntries,
  sortProjectMetas,
  truncate,
};
