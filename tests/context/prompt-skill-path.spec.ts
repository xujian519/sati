import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

test("available skills include the resolved SKILL.md path and bounded lookup guidance", () => {
  const skillPath = "/opt/sati/skills/spreadsheets/SKILL.md";
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [
      {
        name: "spreadsheets",
        description: "Create and edit spreadsheet files.",
        path: skillPath,
      },
    ],
    listMcpInstructions: () => [],
  };
  const prompt = new PromptAssembler(extension).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;

  assert.match(
    prompt,
    /- spreadsheets — Create and edit spreadsheet files\. \(file: \/opt\/sati\/skills\/spreadsheets\/SKILL\.md\)/,
  );
  assert.match(
    prompt,
    /Resolve relative references, scripts, and assets against the directory containing that SKILL\.md\./,
  );
  assert.match(prompt, /Do not search the user's home directory to rediscover a skill/);
});

test("available skills drop per-entry paths when read_skill can load them by name", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [
      {
        name: "spreadsheets",
        description: "Create and edit spreadsheet files.",
        path: "/opt/sati/skills/spreadsheets/SKILL.md",
      },
      {
        name: "patent-search",
        description: "Search prior art.",
        path: "/home/user/.sati/skills/patent-search/SKILL.md",
      },
    ],
    listMcpInstructions: () => [],
  };
  const prompt = new PromptAssembler(extension).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [{ name: "read_skill", description: "Load a skill.", inputSchema: { type: "object" } }],
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;

  assert.match(prompt, /- spreadsheets — Create and edit spreadsheet files\.\n/);
  assert.match(prompt, /- patent-search — Search prior art\.\n/);
  assert.doesNotMatch(prompt, /\(file: /);
  assert.doesNotMatch(prompt, /Resolve relative references/);
  // 根目录去重后按字母序声明一次，供需要 read_file 的场景定位 SKILL.md。
  assert.match(
    prompt,
    /Skills live under these directories[^\n]*\/home\/user\/\.sati\/skills[^\n]*\/opt\/sati\/skills/,
  );
});
