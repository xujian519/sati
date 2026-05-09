import type { PilotDeckToolBehaviorScenario } from "./types.js";

const deferredSource = [
  {
    path: "third-party/claude-code-main/src/tools/ToolSearchTool/prompt.ts",
    summary: "Deferred tools are discoverable via ToolSearch and may be absent from the initial model schema.",
  },
];

export const deferredToolScenarios: PilotDeckToolBehaviorScenario[] = [
  {
    name: "tool_search deferred registry is deferred",
    legacyToolName: "ToolSearch",
    pilotdeckToolName: "tool_search",
    input: { query: "mcp" },
    permissionMode: "default",
    parity: "deferred",
    source: deferredSource,
    deferredUntil: "tool-search-phase",
  },
];
