import type { PolitDeckToolBehaviorScenario } from "./types.js";

export const registryScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "legacy alias resolves to PolitDeck tool",
    legacyToolName: "Read",
    politdeckToolName: "read_file",
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
