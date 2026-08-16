/**
 * src/mcp/client — SDK 工具原始结果 → SatiMcpToolSpec 映射（纯函数）。
 *
 * 从 McpClient.ts 拆出（A6 轮次 1）：清洗 + wireName + 描述截断，
 * serverId 显式参数化（不依赖 this）。
 */

import { recursivelySanitizeUnicode } from "../runtime/sanitize.js";
import { truncateMcpToolDescription } from "../runtime/truncate.js";
import { buildMcpToolWireName } from "../protocol/wireName.js";
import type { SatiMcpToolSpec } from "../protocol/types.js";

export function toToolSpec(raw: unknown, serverId: string): SatiMcpToolSpec {
  const sanitized = recursivelySanitizeUnicode(raw) as {
    name: string;
    description?: string;
    inputSchema?: unknown;
    annotations?: SatiMcpToolSpec["annotations"];
    _meta?: Record<string, unknown>;
  };
  const wireName = buildMcpToolWireName(serverId, sanitized.name);
  return {
    serverId,
    toolName: sanitized.name,
    wireName,
    description: truncateMcpToolDescription(sanitized.description ?? ""),
    inputSchema: sanitized.inputSchema ?? { type: "object", properties: {} },
    annotations: sanitized.annotations,
    meta: sanitized._meta,
  };
}
