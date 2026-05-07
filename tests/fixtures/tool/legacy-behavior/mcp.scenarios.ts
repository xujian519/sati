import type { PolitDeckToolBehaviorScenario } from "./types.js";

const mcpSource = [
  {
    path: "third-party/claude-code-main/src/tools/MCPTool/MCPTool.ts",
    summary: "MCP tools are dynamically adapted and identified by mcp__server__tool wire names.",
  },
  {
    path: "third-party/claude-code-main/src/services/mcp/mcpStringUtils.ts",
    summary: "MCP wire names are used for permission matching and audit metadata.",
  },
];

export const mcpScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "mcp wire name is normalized",
    legacyToolName: "mcp",
    politdeckToolName: "mcp__my_server__read_thing",
    input: {},
    permissionMode: "default",
    parity: "must_match",
    source: mcpSource,
    expectedResultType: "error",
    expectedErrorCode: "unsupported_tool",
  },
  {
    name: "mcp oauth auth tool is deferred",
    legacyToolName: "mcp__server__authenticate",
    politdeckToolName: "mcp__server__authenticate",
    input: {},
    permissionMode: "default",
    parity: "deferred",
    source: mcpSource,
    deferredUntil: "mcp-auth-phase",
  },
];
