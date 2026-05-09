import type { PilotDeckToolBehaviorScenario } from "./types.js";

const permissionSource = [
  {
    path: "third-party/claude-code-main/src/utils/permissions/permissions.ts",
    symbol: "hasPermissionsToUseToolInner",
    summary: "Permission mode and rule ordering governs whether tools allow, ask or deny.",
  },
];

export const permissionModeScenarios: PilotDeckToolBehaviorScenario[] = [
  {
    name: "default mode allows read-only tools",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { filePath: "a.txt" },
    permissionMode: "default",
    parity: "must_match",
    source: permissionSource,
    expectedDecision: "allow",
  },
  {
    name: "default mode asks for writes",
    legacyToolName: "Write",
    pilotdeckToolName: "write_file",
    input: { filePath: "a.txt", content: "x" },
    permissionMode: "default",
    parity: "must_match",
    source: permissionSource,
    expectedDecision: "ask",
  },
  {
    name: "plan mode denies write tools",
    legacyToolName: "Write",
    pilotdeckToolName: "write_file",
    input: { filePath: "a.txt", content: "x" },
    permissionMode: "plan",
    parity: "must_match",
    source: permissionSource,
    expectedDecision: "deny",
  },
  {
    name: "acceptEdits mode allows filesystem edits",
    legacyToolName: "Edit",
    pilotdeckToolName: "edit_file",
    input: { filePath: "a.txt", oldString: "a", newString: "b" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: permissionSource,
    expectedDecision: "allow",
  },
  {
    name: "dontAsk converts asks to deny",
    legacyToolName: "Bash",
    pilotdeckToolName: "bash",
    input: { command: "npm install" },
    permissionMode: "dontAsk",
    parity: "must_match",
    source: permissionSource,
    expectedDecision: "deny",
  },
];
