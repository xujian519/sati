/**
 * Convert the loosely-typed `mcpServers: Record<string, unknown>` blob produced
 * by `PluginRuntime.mcpServers()` (each plugin's manifest) into the strict
 * `PilotDeckMcpServerSpec[]` consumed by `McpRuntime`.
 *
 * Behaviour parity with `third-party/claude-code-main` plugin manifest schema:
 *   - `command` ⇒ stdio transport (`args`/`env`/`cwd` optional).
 *   - `url` (or `httpUrl`) ⇒ streamable_http transport.
 *   - Anything else is silently dropped — we do **not** throw at startup so
 *     a single misconfigured plugin entry can't take down the gateway.
 */

import type { PilotDeckMcpServerSpec } from "../protocol/types.js";

export type ParsePluginMcpServersResult = {
  servers: PilotDeckMcpServerSpec[];
  diagnostics: { id: string; message: string }[];
};

export function parsePluginMcpServers(
  raw: Record<string, unknown> | undefined,
): ParsePluginMcpServersResult {
  const servers: PilotDeckMcpServerSpec[] = [];
  const diagnostics: { id: string; message: string }[] = [];
  if (!raw || typeof raw !== "object") {
    return { servers, diagnostics };
  }
  for (const [id, value] of Object.entries(raw)) {
    if (!id || !value || typeof value !== "object") {
      diagnostics.push({ id, message: "missing or non-object spec" });
      continue;
    }
    const v = value as Record<string, unknown>;
    if (typeof v.command === "string" && v.command.length > 0) {
      servers.push({
        id,
        transport: "stdio",
        command: v.command,
        args: Array.isArray(v.args)
          ? (v.args.filter((a): a is string => typeof a === "string"))
          : undefined,
        env: isStringRecord(v.env) ? (v.env as Record<string, string>) : undefined,
        cwd: typeof v.cwd === "string" ? v.cwd : undefined,
      });
      continue;
    }
    const url = typeof v.url === "string" ? v.url : typeof v.httpUrl === "string" ? v.httpUrl : undefined;
    if (url) {
      servers.push({
        id,
        transport: "streamable_http",
        url,
        headers: isStringRecord(v.headers) ? (v.headers as Record<string, string>) : undefined,
      });
      continue;
    }
    diagnostics.push({ id, message: "no recognized transport (need command or url)" });
  }
  return { servers, diagnostics };
}

function isStringRecord(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  for (const value of Object.values(v as Record<string, unknown>)) {
    if (typeof value !== "string") return false;
  }
  return true;
}
