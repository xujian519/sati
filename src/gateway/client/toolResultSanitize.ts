/**
 * src/gateway/client — 工具结果清洗/截断（纯函数）。
 *
 * 从 InProcessGateway.ts 拆出（A11 轮次 1）：工具结果预览截断、data 递归
 * 清洗、头尾对称截断、路径安全化、MIME 扩展名映射——零依赖纯函数。
 */

const MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS = 20_000;
const MAX_GATEWAY_TOOL_DATA_STRING_CHARS = 4_000;

export function limitGatewayToolResultPreview(text: string): string {
  if (text.length <= MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS) {
    return text;
  }
  const marker = `\n\n... [Gateway preview truncated: ${text.length - MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS} characters omitted; full result remains available through persisted tool-result references when shown to the model.] ...\n\n`;
  const available = Math.max(0, MAX_GATEWAY_TOOL_RESULT_PREVIEW_CHARS - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

export function sanitizeGatewayToolData(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeGatewayToolDataValue(value);
  return isRecord(sanitized) ? sanitized : { value: sanitized };
}

function sanitizeGatewayToolDataValue(value: unknown): unknown {
  if (typeof value === "string") {
    return limitGatewayToolDataString(value);
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeGatewayToolDataValue);
  }
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = sanitizeGatewayToolDataValue(item);
    }
    return output;
  }
  return value;
}

export function limitGatewayToolDataString(
  value: string,
): string | { preview: string; originalChars: number; originalBytes: number; truncated: true } {
  if (value.length <= MAX_GATEWAY_TOOL_DATA_STRING_CHARS) {
    return value;
  }
  return {
    preview: headTailString(value, MAX_GATEWAY_TOOL_DATA_STRING_CHARS, "Gateway data string truncated"),
    originalChars: value.length,
    originalBytes: Buffer.byteLength(value, "utf8"),
    truncated: true,
  };
}

export function headTailString(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  const marker = `\n\n... [${label}: ${text.length - maxChars} characters omitted] ...\n\n`;
  const available = Math.max(0, maxChars - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function previewUnknown(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function safeGatewayPathPart(value: string): string {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "value"
  );
}

export function extensionForMime(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}
