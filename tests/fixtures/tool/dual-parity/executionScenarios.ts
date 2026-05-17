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
    pilotdeck: { toolName: "read_file", input: { file_path: "a.txt" } },
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
    status: "intentional_difference",
    workspace: {},
    legacy: { toolName: "Bash", input: { command: "sh -c 'exit 2'" } },
    pilotdeck: { toolName: "bash", input: { command: "sh -c 'exit 2'" } },
    // Both legacy and PilotDeck still surface the same `tool_execution_failed`
    // errorCode (status="error"), but PilotDeck includes the exit code and
    // stderr/stdout context in the error text (e.g. "Command exited with
    // code 2: sh -c 'exit 2'\n\nstderr: …") instead of the literal opaque
    // "Shell command failed" the legacy BashTool returns. See
    // `intentional-differences.ts#bash-non-zero-message-context` for the
    // rationale (agent + UI need diagnostic info to distinguish "files were
    // already deleted" from a real infrastructure failure).
    reason:
      "PilotDeck bash error text includes exitCode/stdout/stderr context for diagnosis; legacy returns the literal 'Shell command failed'.",
  },
  {
    id: "grep-content-mode",
    status: "deferred",
    workspace: {
      "src/a.txt": "needle\n",
    },
    legacy: { toolName: "Grep", input: { pattern: "needle", output_mode: "content" } },
    pilotdeck: { toolName: "grep", input: { pattern: "needle", output_mode: "content" } },
    reason: "Legacy Grep execution import currently hits a vendored circular UI import in direct harness mode.",
  },
];
