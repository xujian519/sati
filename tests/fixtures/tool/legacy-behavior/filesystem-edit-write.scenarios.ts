import type { PilotDeckToolBehaviorScenario } from "./types.js";

const editSource = [
  {
    path: "third-party/claude-code-main/src/tools/FileEditTool/FileEditTool.ts",
    summary: "Edit performs exact string replacement and rejects missing or ambiguous old strings.",
  },
  {
    path: "third-party/claude-code-main/src/tools/FileWriteTool/FileWriteTool.ts",
    summary: "Write creates or overwrites files under permission control.",
  },
];

export const filesystemEditWriteScenarios: PilotDeckToolBehaviorScenario[] = [
  {
    name: "edit exact occurrence succeeds in acceptEdits",
    legacyToolName: "Edit",
    pilotdeckToolName: "edit_file",
    input: { file_path: "edit.txt", old_string: "alpha", new_string: "beta" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "success",
  },
  {
    name: "edit missing old string returns invalid input",
    legacyToolName: "Edit",
    pilotdeckToolName: "edit_file",
    input: { file_path: "edit.txt", old_string: "missing", new_string: "beta" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "error",
    expectedErrorCode: "invalid_tool_input",
  },
  {
    name: "write creates file in acceptEdits",
    legacyToolName: "Write",
    pilotdeckToolName: "write_file",
    input: { file_path: "created.txt", content: "created" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "success",
  },
  {
    name: "write overwrite without flag returns conflict",
    legacyToolName: "Write",
    pilotdeckToolName: "write_file",
    input: { file_path: "existing.txt", content: "new" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "error",
    expectedErrorCode: "file_conflict",
  },
];
