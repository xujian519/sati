// file-memory 的文本工具（从 file-memory.ts 拆出，逐字搬移）。纯函数层。
import { mkdirSync } from "node:fs";

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function normalizeWhitespace(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeDescription(value: string | undefined, fallback = ""): string {
  return normalizeWhitespace(value) || normalizeWhitespace(fallback);
}

function slugify(value: string): string {
  const normalized = normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "memory-item";
}

function uniqueStrings(values: Array<string | undefined>, max = 50): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const normalized = normalizeWhitespace(value);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    next.push(normalized);
    if (next.length >= max) break;
  }
  return next;
}

function splitLines(value: string): string[] {
  return value.replace(/\r\n/g, "\n").split("\n");
}

function trimContentLines(content: string, maxLines: number): string {
  if (maxLines <= 0) return "";
  const lines = splitLines(content);
  if (lines.length <= maxLines) return content;
  return `${lines.slice(0, maxLines).join("\n")}\n...`;
}

function previewContent(content: string, maxChars = 220): string {
  const normalized = normalizeWhitespace(content.replace(/^#+\s+/gm, ""));
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseInteger(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseStringArray(value: string | undefined): string[] {
  const raw = normalizeWhitespace(value);
  if (!raw) return [];
  if (raw.startsWith("[") && raw.endsWith("]")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return uniqueStrings(parsed.filter((item): item is string => typeof item === "string"));
      }
    } catch {
      // JSON 数组解析失败：回退按分隔符解析原字符串（保守降级）。
    }
  }
  return uniqueStrings(raw.split("|"));
}

export {
  ensureDir,
  normalizeDescription,
  normalizeWhitespace,
  parseBoolean,
  parseInteger,
  parseStringArray,
  previewContent,
  slugify,
  splitLines,
  trimContentLines,
  uniqueStrings,
};
