import type { PolitDeckToolBehaviorScenario } from "./types.js";

const bashSource = [
  {
    path: "third-party/claude-code-main/src/tools/BashTool/BashTool.tsx",
    summary: "Bash returns stdout/stderr/exit status and non-zero process exit does not crash the agent loop.",
  },
  {
    path: "third-party/claude-code-main/src/tools/BashTool/bashPermissions.ts",
    summary: "Dangerous shell commands are protected by safety permission checks.",
  },
];

export const bashExecutionScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "safe shell command succeeds",
    legacyToolName: "Bash",
    politdeckToolName: "bash",
    input: { command: "pwd" },
    permissionMode: "default",
    parity: "must_match",
    source: bashSource,
    expectedResultType: "success",
  },
  {
    name: "non-zero exit is returned as tool output",
    legacyToolName: "Bash",
    politdeckToolName: "bash",
    input: { command: "sh -c 'exit 2'" },
    permissionMode: "default",
    parity: "must_match",
    source: bashSource,
    expectedResultType: "error",
    expectedErrorCode: "tool_execution_failed",
  },
  {
    name: "dangerous shell command is denied in bypass",
    legacyToolName: "Bash",
    politdeckToolName: "bash",
    input: { command: "sudo whoami" },
    permissionMode: "bypassPermissions",
    parity: "must_match",
    source: bashSource,
    expectedResultType: "error",
    expectedErrorCode: "permission_denied",
  },
  {
    name: "background bash is deferred",
    legacyToolName: "Bash",
    politdeckToolName: "bash",
    input: { command: "sleep 60", runInBackground: true },
    permissionMode: "default",
    parity: "deferred",
    source: bashSource,
    deferredUntil: "task-runtime-phase",
    notes: "PolitDeck Phase 1 does not implement background task handles.",
  },
];
