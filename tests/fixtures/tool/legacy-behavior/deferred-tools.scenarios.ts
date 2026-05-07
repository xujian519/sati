import type { PolitDeckToolBehaviorScenario } from "./types.js";

const deferredSource = [
  {
    path: "third-party/claude-code-main/src/tools/ToolSearchTool/prompt.ts",
    summary: "Deferred tools are discoverable via ToolSearch and may be absent from the initial model schema.",
  },
];

export const deferredToolScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "tool_search deferred registry is deferred",
    legacyToolName: "ToolSearch",
    politdeckToolName: "tool_search",
    input: { query: "mcp" },
    permissionMode: "default",
    parity: "deferred",
    source: deferredSource,
    deferredUntil: "tool-search-phase",
  },
];
