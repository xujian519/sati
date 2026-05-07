import type { PolitDeckToolBehaviorScenario } from "./types.js";

const searchSource = [
  {
    path: "third-party/claude-code-main/src/tools/GlobTool/GlobTool.ts",
    summary: "Glob is read-only and returns bounded workspace file matches.",
  },
  {
    path: "third-party/claude-code-main/src/tools/GrepTool/GrepTool.ts",
    summary: "Grep supports files, content and count result modes with bounded output.",
  },
];

export const filesystemSearchScenarios: PolitDeckToolBehaviorScenario[] = [
  {
    name: "glob matches TypeScript files",
    legacyToolName: "Glob",
    politdeckToolName: "glob",
    input: { pattern: "**/*.ts" },
    permissionMode: "default",
    parity: "must_match",
    source: searchSource,
    expectedResultType: "success",
    expectedContentIncludes: ["src/a.ts"],
  },
  {
    name: "grep files_with_matches mode succeeds",
    legacyToolName: "Grep",
    politdeckToolName: "grep",
    input: { pattern: "needle" },
    permissionMode: "default",
    parity: "must_match",
    source: searchSource,
    expectedResultType: "success",
    expectedContentIncludes: ["src/a.ts"],
  },
  {
    name: "grep content mode includes matching line",
    legacyToolName: "Grep",
    politdeckToolName: "grep",
    input: { pattern: "needle", outputMode: "content", context: 0 },
    permissionMode: "default",
    parity: "must_match",
    source: searchSource,
    expectedResultType: "success",
    expectedContentIncludes: ["needle"],
  },
  {
    name: "grep count mode reports match count",
    legacyToolName: "Grep",
    politdeckToolName: "grep",
    input: { pattern: "needle", outputMode: "count" },
    permissionMode: "default",
    parity: "must_match",
    source: searchSource,
    expectedResultType: "success",
    expectedContentIncludes: ["src/a.ts:1"],
  },
];
