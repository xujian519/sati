/**
 * 技能/角色清单的工作区专利裁剪（#450 构件②）。
 *
 * 判据为否时 `<available-skills>` / `<available-roles>` 不列专利条目——省下约 3.7k
 * tokens（本机 63 条技能 3,650 + 32 条角色 1,890 中的专利部分）。**只裁清单不裁注册**：
 * 模型仍可经 `read_skill` 按名读到专利技能，误判不会造成能力不可达。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

function extensionWith(skills: ExtensionResolver["listSkills"] extends () => infer R ? R : never): ExtensionResolver {
  return { listCommands: () => [], listSkills: () => skills, listMcpInstructions: () => [] };
}

const SKILLS = [
  { name: "spreadsheets", description: "Spreadsheet helper.", path: "/opt/sati/skills/spreadsheets/SKILL.md" },
  { name: "patent-search", description: "Search prior art.", path: "/opt/sati/skills/patent-search/SKILL.md" },
  { name: "drafting-claims", description: "Draft claims.", path: "/opt/sati/skills/drafting-claims/SKILL.md" },
  {
    name: "provision-novelty",
    description: "Novelty analysis role.",
    path: "/opt/sati/skills/provision-novelty/SKILL.md",
    role: { domains: ["patent"], tools: [] },
  },
];

function assemble(options: { patentDomainEnabled?: boolean }) {
  return new PromptAssembler(extensionWith(SKILLS), options).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [{ name: "read_skill", description: "Load a skill.", inputSchema: { type: "object" } }],
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;
}

test("专利工作区（或缺省）列出全部技能与角色", () => {
  for (const options of [{}, { patentDomainEnabled: true }]) {
    const prompt = assemble(options);
    assert.match(prompt, /- spreadsheets — /);
    assert.match(prompt, /- patent-search — /);
    assert.match(prompt, /- drafting-claims — /);
    assert.match(prompt, /<available-roles>/);
    assert.match(prompt, /- provision-novelty — /);
  }
});

test("非专利工作区不列专利技能与专利角色，其他技能照常", () => {
  const prompt = assemble({ patentDomainEnabled: false });
  assert.match(prompt, /- spreadsheets — /);
  assert.doesNotMatch(prompt, /patent-search/);
  assert.doesNotMatch(prompt, /drafting-claims/);
  assert.doesNotMatch(prompt, /provision-novelty/);
  assert.doesNotMatch(prompt, /<available-roles>/);
});

test("全部技能都是专利技能时两个清单块整体消失（不留空壳）", () => {
  const extension = extensionWith([SKILLS[1]!]);
  const prompt = new PromptAssembler(extension, { patentDomainEnabled: false }).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;
  assert.doesNotMatch(prompt, /available-skills/);
  assert.doesNotMatch(prompt, /available-roles/);
});
