import type { PolitDeckToolBehaviorScenario } from "./types.js";

const resultSource = [
  {
    path: "third-party/claude-code-main/src/services/tools/toolExecution.ts",
    summary: "Tool successes and failures are mapped back as model-visible tool_result blocks.",
  },
  {
    path: "third-party/claude-code-main/src/utils/toolResultStorage.ts",
    summary: "Large or empty tool results are normalized before returning to the model.",
  },
];

export const resultMappingScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "success result maps to canonical tool_result",
    legacyToolName: "Read",
    politdeckToolName: "read_file",
    input: { filePath: "src/a.txt" },
    permissionMode: "default",
    parity: "must_match",
    source: resultSource,
    expectedResultType: "success",
  },
  {
    name: "error result maps to canonical error tool_result",
    legacyToolName: "Write",
    politdeckToolName: "write_file",
    input: { filePath: "../outside.txt", content: "x" },
    permissionMode: "acceptEdits",
    parity: "must_match",
    source: resultSource,
    expectedResultType: "error",
    expectedErrorCode: "path_not_allowed",
  },
];
