/**
 * 技能清单分组（渲染层）：compact 组只列名字 + 组级摘要，名字不透明的组保留描述。
 * 归组只看 slug 前缀，不改技能注册——`SkillManager.listSkillsIn()` 仍是单层扫描。
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { ContributedSkill, ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { groupSkills, skillGroupFor } from "../../src/context/prompt/skillGroups.js";

function skill(name: string, description: string): ContributedSkill {
  return { name, description, path: `/opt/sati/skills/${name}/SKILL.md` };
}

function assemble(
  skills: ContributedSkill[],
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[],
) {
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => skills,
    listMcpInstructions: () => [],
  };
  return new PromptAssembler(extension).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;
}

test("skillGroupFor：legal-* 按第二段归组并标记 compact", () => {
  const meta = skillGroupFor("legal-litigation-demand-draft");
  assert.equal(meta.id, "legal/litigation");
  assert.equal(meta.label, "Legal · Litigation");
  assert.equal(meta.compact, true);
  assert.ok(meta.description);

  const fallback = skillGroupFor("legal-research");
  assert.equal(fallback.id, "legal/other");
  assert.equal(fallback.compact, true);
});

test("skillGroupFor：未登记的新法务子域自动成组，不需要手工重排", () => {
  const meta = skillGroupFor("legal-foo-bar");
  assert.equal(meta.id, "legal/foo");
  assert.equal(meta.label, "Legal · Foo");
  assert.equal(meta.compact, true);
});

test("skillGroupFor：专利前缀同组，未知前缀落 general 且保留描述", () => {
  for (const name of ["patent-search", "provision-novelty", "drafting-claims"]) {
    const meta = skillGroupFor(name);
    assert.equal(meta.id, "patent");
    assert.equal(meta.compact, true);
  }
  const general = skillGroupFor("some-new-tool");
  assert.equal(general.id, "general");
  assert.equal(general.compact, false);
});

test("groupSkills：组间按 order 排列，组内保持输入顺序", () => {
  const groups = groupSkills([
    skill("gog", "Read mail."),
    skill("legal-litigation-matter-intake", "Matter intake."),
    skill("patent-search", "Search prior art."),
    skill("legal-litigation-chronology", "Build a chronology."),
  ]);
  assert.deepEqual(
    groups.map(group => group.id),
    ["patent", "legal/litigation", "integrations"],
  );
  assert.deepEqual(
    groups[1]?.skills.map(entry => entry.name),
    ["legal-litigation-matter-intake", "legal-litigation-chronology"],
  );
});

test("清单：compact 组只列名字并带组级摘要，verbose 组保留逐条描述", () => {
  const prompt = assemble(
    [
      skill("legal-litigation-demand-draft", "Draft a demand letter."),
      skill("patent-search", "Search prior art."),
      skill("pdf", "Fill and split PDFs."),
    ],
    [{ name: "read_skill", description: "Load a skill.", inputSchema: { type: "object" } }],
  );
  assert.match(prompt, /- Patent \(1 skills\) — /);
  assert.match(prompt, /- Legal · Litigation \(1 skills\) — /);
  assert.match(prompt, /names: legal-litigation-demand-draft/);
  assert.match(prompt, /names: patent-search/);
  // compact 组省略逐条描述
  assert.doesNotMatch(prompt, /legal-litigation-demand-draft — Draft a demand letter\./);
  // 名字不透明的组保留描述
  assert.match(prompt, /\n {2}- pdf — Fill and split PDFs\./);
  assert.doesNotMatch(prompt, /\(file: /);
});

test("清单：无 read_skill 时 compact 组逐条带 SKILL.md 路径", () => {
  const prompt = assemble([skill("patent-search", "Search prior art.")], []);
  assert.match(prompt, /\n {2}- patent-search \(file: \/opt\/sati\/skills\/patent-search\/SKILL\.md\)/);
  assert.match(prompt, /Resolve relative references/);
});

test("清单：list_skills 在场时提示按组展开逐条描述", () => {
  const prompt = assemble(
    [skill("legal-litigation-demand-draft", "Draft a demand letter.")],
    [
      { name: "read_skill", description: "Load a skill.", inputSchema: { type: "object" } },
      { name: "list_skills", description: "List skill groups.", inputSchema: { type: "object" } },
    ],
  );
  assert.match(prompt, /Call list_skills with a group id/);
});
