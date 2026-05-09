export type DualParityExecutionStatus = "compare" | "intentional_difference" | "deferred" | "not_applicable";

export type DualParityExecutionScenario = {
  id: string;
  status: DualParityExecutionStatus;
  workspace: Record<string, string>;
  legacy: {
    toolName: string;
    input: Record<string, unknown>;
  };
  pilotdeck: {
    toolName: string;
    input: Record<string, unknown>;
  };
  reason?: string;
};

export type DualParityExecutionReport = {
  id: string;
  status: DualParityExecutionStatus;
  legacyToolName: string;
  pilotdeckToolName: string;
  result?: {
    status: "success" | "error";
    text?: string;
    errorCode?: string;
    data?: Record<string, unknown>;
  };
  reason?: string;
};

export const dualParityExecutionScenarios: DualParityExecutionScenario[] = [
  {
    id: "read-existing-text",
    status: "compare",
    workspace: {
      "a.txt": "one\ntwo\n",
    },
    legacy: { toolName: "Read", input: { file_path: "__WORKSPACE__/a.txt", offset: 1 } },
    pilotdeck: { toolName: "read_file", input: { filePath: "a.txt" } },
  },
  {
    id: "glob-ts-files",
    status: "compare",
    workspace: {
      "src/a.ts": "export const a = 1;\n",
      "src/b.js": "console.log('b');\n",
    },
    legacy: { toolName: "Glob", input: { pattern: "**/*.ts", path: "__WORKSPACE__" } },
    pilotdeck: { toolName: "glob", input: { pattern: "**/*.ts", path: "." } },
  },
  {
    id: "bash-printf",
    status: "compare",
    workspace: {},
    legacy: { toolName: "Bash", input: { command: "printf hello" } },
    pilotdeck: { toolName: "bash", input: { command: "printf hello" } },
  },
  {
    id: "bash-non-zero",
    status: "compare",
    workspace: {},
    legacy: { toolName: "Bash", input: { command: "sh -c 'exit 2'" } },
    pilotdeck: { toolName: "bash", input: { command: "sh -c 'exit 2'" } },
  },
  {
    id: "grep-content-mode",
    status: "deferred",
    workspace: {
      "src/a.txt": "needle\n",
    },
    legacy: { toolName: "Grep", input: { pattern: "needle", output_mode: "content" } },
    pilotdeck: { toolName: "grep", input: { pattern: "needle", outputMode: "content" } },
    reason: "Legacy Grep execution import currently hits a vendored circular UI import in direct harness mode.",
  },
];
