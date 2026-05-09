/**
 * MCP runtime protocol (C1 §6.1 of the deferred-feature guide).
 * Mirrors the legacy contracts in `services/mcp/client.ts` (M1-M16).
 */

export type PolitDeckMcpServerSpec =
  | {
      id: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      cwd?: string;
    }
  | {
      id: string;
      transport: "streamable_http";
      url: string;
      headers?: Record<string, string>;
    };

export type PolitDeckMcpToolAnnotations = {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  idempotentHint?: boolean;
};

/**
 * Runtime view of a tool advertised by an MCP server. Already sanitized
 * (M9), wire-named (M10), and description-truncated (M11).
 */
export type PolitDeckMcpToolSpec = {
  serverId: string;
  toolName: string;
  wireName: string;
  description: string;
  inputSchema: unknown;
  annotations?: PolitDeckMcpToolAnnotations;
  meta?: Record<string, unknown>;
};

export type PolitDeckMcpStatus =
  | "idle"
  | "connecting"
  | "ready"
  | "error"
  | "needs-auth";

export type PolitDeckMcpServerInstructions = {
  serverId: string;
  instructions: string;
};

export type PolitDeckMcpClientStatusEntry = {
  serverId: string;
  status: PolitDeckMcpStatus;
  error?: string;
};
