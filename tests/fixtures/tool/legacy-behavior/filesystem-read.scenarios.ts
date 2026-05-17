import type { PilotDeckToolBehaviorScenario } from "./types.js";

const readSource = [
  {
    path: "third-party/claude-code-main/src/tools/FileReadTool/FileReadTool.ts",
    summary: "Read is a read-only tool that returns controlled errors for invalid filesystem targets.",
  },
  {
    path: "third-party/claude-code-main/src/utils/permissions/filesystem.ts",
    summary: "Filesystem access must stay inside allowed workspace roots.",
  },
];

export const filesystemReadScenarios: PilotDeckToolBehaviorScenario[] = [
  {
    name: "read text file succeeds",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { file_path: "src/a.txt" },
    permissionMode: "default",
    parity: "must_match",
    source: readSource,
    expectedResultType: "success",
    expectedContentIncludes: ["one", "two"],
  },
  {
    name: "read missing file returns controlled error",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { file_path: "missing.txt" },
    permissionMode: "default",
    parity: "must_match",
    source: readSource,
    expectedResultType: "error",
    expectedErrorCode: "file_not_found",
  },
  {
    name: "read outside workspace is denied",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { file_path: "../outside.txt" },
    permissionMode: "default",
    parity: "must_match",
    source: readSource,
    expectedResultType: "error",
    expectedErrorCode: "path_not_allowed",
  },
  {
    name: "read binary-like file is a controlled difference",
    legacyToolName: "Read",
    pilotdeckToolName: "read_file",
    input: { file_path: "bin.dat" },
    permissionMode: "default",
    parity: "intentional_difference",
    source: readSource,
    expectedResultType: "error",
    expectedErrorCode: "invalid_tool_input",
    intentionalDifferenceReason: "PilotDeck Phase 1 supports UTF-8 text reads only.",
  },
];
