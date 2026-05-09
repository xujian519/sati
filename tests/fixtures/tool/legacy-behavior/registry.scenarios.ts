import type { PilotDeckToolBehaviorScenario } from "./types.js";

export const registryScenarios: PilotDeckToolBehaviorScenario[] = [
  {
    name: "legacy alias resolves to PilotDeck tool",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { alias: "Read" },
    permissionMode: "default",
    parity: "must_match",
    source: [
      {
        path: "third-party/claude-code-main/src/Tool.ts",
        symbol: "toolMatchesName",
        summary: "Tool lookup supports primary names and aliases for compatibility.",
      },
    ],
  },
];
