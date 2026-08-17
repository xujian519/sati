// llm-extraction 的 JSON 解析层（从 llm-extraction.ts 拆出，G4 聚类）。
// 纯函数：无 IO、无外部状态，可独立单测。LLM 输出为宽松/带噪 JSON，解析语义
// 必须保持（错误消息被 debugTrace/logger 依赖）。

interface RawMemoryCreatePayload {
  skip?: unknown;
  reason?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

function extractFirstJsonObject(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;

  const start = trimmed.indexOf("{");
  if (start < 0) throw new Error("No JSON object found in extraction response");

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < trimmed.length; index += 1) {
    const char = trimmed[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return trimmed.slice(start, index + 1);
    }
  }

  throw new Error("Incomplete JSON object in extraction response");
}

function extractLooseJsonEnvelope(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Empty extraction response");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("No JSON envelope found in extraction response");
  }
  return trimmed.slice(start, end + 1);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeLooseJsonString(value: string): string {
  return value
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
}

function extractLooseJsonBooleanProperty(source: string, key: string): boolean | undefined {
  const match = source.match(new RegExp(`"${escapeRegexLiteral(key)}"\\s*:\\s*(true|false)`, "i"));
  if (!match) return undefined;
  return match[1]?.toLowerCase() === "true";
}

function extractLooseJsonStringProperty(source: string, key: string, nextKeys: string[]): string | undefined {
  const escapedKey = escapeRegexLiteral(key);
  const nextKeyPattern = nextKeys.map(item => escapeRegexLiteral(item)).join("|");
  const pattern =
    nextKeys.length > 0
      ? new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*?)"\\s*,\\s*"(${nextKeyPattern})"\\s*:`, "i")
      : new RegExp(`"${escapedKey}"\\s*:\\s*"([\\s\\S]*)"\\s*}\\s*$`, "i");
  const match = source.match(pattern);
  return match?.[1] ? decodeLooseJsonString(match[1]) : undefined;
}

function tryParseLooseMemoryCreatePayload(raw: string): RawMemoryCreatePayload | null {
  const envelope = extractLooseJsonEnvelope(raw);
  const payload: RawMemoryCreatePayload = {
    ...(extractLooseJsonBooleanProperty(envelope, "skip") !== undefined
      ? { skip: extractLooseJsonBooleanProperty(envelope, "skip") }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"])
      ? { reason: extractLooseJsonStringProperty(envelope, "reason", ["name", "description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"])
      ? { name: extractLooseJsonStringProperty(envelope, "name", ["description", "markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "description", ["markdown"])
      ? { description: extractLooseJsonStringProperty(envelope, "description", ["markdown"]) }
      : {}),
    ...(extractLooseJsonStringProperty(envelope, "markdown", [])
      ? { markdown: extractLooseJsonStringProperty(envelope, "markdown", []) }
      : {}),
  };
  return typeof payload.name === "string" &&
    typeof payload.description === "string" &&
    typeof payload.markdown === "string"
    ? payload
    : null;
}

export {
  decodeLooseJsonString,
  extractFirstJsonObject,
  extractLooseJsonBooleanProperty,
  extractLooseJsonEnvelope,
  extractLooseJsonStringProperty,
  tryParseLooseMemoryCreatePayload,
  type RawMemoryCreatePayload,
};
