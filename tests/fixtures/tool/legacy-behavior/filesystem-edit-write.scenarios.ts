import type { PolitDeckToolBehaviorScenario } from "./types.js";

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

export const filesystemEditWriteScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "edit exact occurrence succeeds in acceptEdits",
    legacyToolName: "Edit",
    politdeckToolName: "edit_file",
    input: { filePath: "edit.txt", oldString: "alpha", newString: "beta" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "success",
  },
  {
    name: "edit missing old string returns invalid input",
    legacyToolName: "Edit",
    politdeckToolName: "edit_file",
    input: { filePath: "edit.txt", oldString: "missing", newString: "beta" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "error",
    expectedErrorCode: "invalid_tool_input",
  },
  {
    name: "write creates file in acceptEdits",
    legacyToolName: "Write",
    politdeckToolName: "write_file",
    input: { filePath: "created.txt", content: "created" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "success",
  },
  {
    name: "write overwrite without flag returns conflict",
    legacyToolName: "Write",
    politdeckToolName: "write_file",
    input: { filePath: "existing.txt", content: "new" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: editSource,
    expectedResultType: "error",
    expectedErrorCode: "file_conflict",
  },
];
