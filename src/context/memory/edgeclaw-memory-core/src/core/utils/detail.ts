import type { RetrievalTraceDetail, TraceI18nText } from "../types.js";
import { decodeEscapedUnicodeText, decodeEscapedUnicodeValue } from "./text.js";

export type TraceDetailOptions = {
  /**
   * 是否对字符串字段做转义解码（默认 true）。
   * heartbeat / reasoning-loop 等数据源含 LLM 输出的转义序列需要解码；
   * 已预解码的数据源（如 dream-review）传 `{ decode: false }` 保留原始值。
   */
  decode?: boolean;
};

export function kvDetail(
  key: string,
  label: string,
  entries: Array<{ label: string; value: unknown }>,
  labelI18n?: TraceI18nText,
  options: TraceDetailOptions = {},
): RetrievalTraceDetail {
  const { decode = true } = options;
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "kv",
    entries: entries.map(entry => ({
      label: entry.label,
      value: decode ? decodeEscapedUnicodeText(String(entry.value ?? ""), true) : String(entry.value ?? ""),
    })),
  };
}

export function listDetail(
  key: string,
  label: string,
  items: string[],
  labelI18n?: TraceI18nText,
  options: TraceDetailOptions = {},
): RetrievalTraceDetail {
  const { decode = true } = options;
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "list",
    items: decode ? items.map(item => decodeEscapedUnicodeText(item, true)) : items,
  };
}

export function jsonDetail(
  key: string,
  label: string,
  json: unknown,
  labelI18n?: TraceI18nText,
  options: TraceDetailOptions = {},
): RetrievalTraceDetail {
  const { decode = true } = options;
  return {
    key,
    label,
    ...(labelI18n ? { labelI18n } : {}),
    kind: "json",
    json: decode ? decodeEscapedUnicodeValue(json, true) : json,
  };
}
