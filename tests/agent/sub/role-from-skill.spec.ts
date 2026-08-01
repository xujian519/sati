import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  getSubagentDefinition,
  listAllSubagentDefinitions,
  listRegisteredRoleIds,
  registerRoleDefinition,
  unregisterRoleDefinition,
  type SubagentDefinition,
} from "../../../src/agent/sub/builtinSubagentTypes.js";
import { roleFromContribution, roleFromSkill, rolesFromSkills } from "../../../src/agent/sub/roleFromSkill.js";
import { scopeToolsForDefinition } from "../../../src/agent/sub/scopeTools.js";
import { SkillManager } from "../../../src/extension/skills/SkillManager.js";
import type { PluginSkillContribution } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import type { SkillSummary } from "../../../src/extension/skills/types.js";
import { createBuiltinRegistry } from "../../../src/tool/registry/createBuiltinRegistry.js";

function roleSkillSummary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    slug: "writer",
    name: "撰写专家",
    description: "专利撰写角色",
    version: null,
    skillFile: "/tmp/writer/SKILL.md",
    skillDir: "/tmp/writer",
    scope: "user",
    readonly: false,
    mtime: null,
    role: {
      tools: ["*"],
      domains: ["drafting", "quality", "patent", "filesystem", "session"],
      omitTools: ["web_search"],
      readOnly: false,
      systemPrompt: "你是专利撰写专家。",
    },
    ...overrides,
  };
}

test("roleFromSkill converts role skill to SubagentDefinition", () => {
  const definition = roleFromSkill(roleSkillSummary());
  assert.ok(definition !== null);
  assert.equal(definition?.id, "writer");
  assert.equal(definition?.description, "专利撰写角色");
  assert.deepEqual(definition?.visibleDomains, ["drafting", "quality", "patent", "filesystem", "session"]);
  assert.deepEqual(definition?.omitTools, ["web_search"]);
  assert.equal(definition?.isReadOnly, false);
  assert.equal(definition?.systemPromptSuffix, "你是专利撰写专家。");
  assert.deepEqual(definition?.allowedTools, ["*"]);
});

test("roleFromSkill returns null for plain skills", () => {
  const plain = roleSkillSummary({ role: null });
  assert.equal(roleFromSkill(plain), null);
});

test("roleFromSkill defaults tools to wildcard when absent", () => {
  const definition = roleFromSkill(roleSkillSummary({ role: { domains: ["filesystem"], readOnly: true } }));
  assert.deepEqual(definition?.allowedTools, ["*"]);
  assert.equal(definition?.isReadOnly, true);
  assert.equal(definition?.systemPromptSuffix, "");
});

test("rolesFromSkills collects and dedupes role definitions", () => {
  const skills: SkillSummary[] = [
    roleSkillSummary(),
    roleSkillSummary({ slug: "writer", role: null }),
    roleSkillSummary({ slug: "analyzer", description: "分析专家" }),
  ];
  const roles = rolesFromSkills(skills);
  assert.equal(roles.length, 2);
  assert.deepEqual(roles.map(r => r.id).sort(), ["analyzer", "writer"]);
});

test("roleFromContribution converts plugin contribution role", () => {
  const contribution: PluginSkillContribution = {
    name: "writer",
    description: "专利撰写角色",
    path: "/tmp/writer/SKILL.md",
    role: { domains: ["drafting"], readOnly: false },
  };
  const definition = roleFromContribution(contribution);
  assert.ok(definition !== null);
  assert.equal(definition?.id, "writer");
  assert.deepEqual(definition?.visibleDomains, ["drafting"]);
  assert.deepEqual(definition?.allowedTools, ["*"]);
  assert.equal(roleFromContribution({ ...contribution, role: undefined }), null);
});

test("roleFromContribution rejects unsafe role names", () => {
  const unsafe = ["../evil", "a b", "x/y", "<script>"];
  for (const name of unsafe) {
    const definition = roleFromContribution({
      name,
      path: `/tmp/${name}/SKILL.md`,
      role: { readOnly: true },
    });
    assert.equal(definition, null, `name ${name} 应被拒绝`);
  }
});

test("registerRoleDefinition makes role visible to subagent lookup", () => {
  const definition = roleFromSkill(roleSkillSummary());
  assert.ok(definition !== null);
  registerRoleDefinition(definition);
  try {
    const found = getSubagentDefinition("writer");
    assert.equal(found?.id, "writer");
    const all = listAllSubagentDefinitions();
    assert.ok(all.some(d => d.id === "writer"));
    assert.ok(
      all.some(d => d.id === "explore"),
      "内置预设不受影响",
    );
  } finally {
    unregisterRoleDefinition("writer");
  }
  assert.equal(getSubagentDefinition("writer"), undefined);
});

test("role registry cleanup removes same-name roles shadowing builtins", () => {
  // 注册与内置同名的角色（general-purpose）：getSubagentDefinition 命中角色定义
  const shadow: SubagentDefinition = {
    id: "general-purpose",
    description: "shadow role",
    allowedTools: ["read_file"],
    omitProjectInstructions: false,
    omitGitStatus: false,
    isReadOnly: true,
    systemPromptSuffix: "shadow",
    visibleDomains: ["filesystem"],
  };
  registerRoleDefinition(shadow);
  try {
    assert.equal(getSubagentDefinition("general-purpose")?.description, "shadow role");
    // 宿主清理：listRegisteredRoleIds 应包含同名角色（不被内置过滤掉）
    assert.ok(listRegisteredRoleIds().includes("general-purpose"));
  } finally {
    unregisterRoleDefinition("general-purpose");
  }
  // 清理后回退到内置定义（不再是 shadow role）
  assert.notEqual(getSubagentDefinition("general-purpose")?.description, "shadow role");
  assert.ok(getSubagentDefinition("general-purpose")?.description.includes("General-purpose"));
});

test("role-scoped tools: domains + omitTools shape the scoped registry", () => {
  const registry = createBuiltinRegistry();
  const scoped = scopeToolsForDefinition(registry.list(), {
    allowedTools: ["*"],
    visibleDomains: ["drafting", "quality", "patent", "filesystem", "session"],
    omitTools: ["web_search", "web_fetch", "execute_code"],
  });
  const names = scoped.map(t => t.name);
  assert.ok(names.includes("draft_claims"));
  assert.ok(names.includes("rule_check"));
  assert.ok(names.includes("read_file"));
  assert.ok(!names.includes("bash"));
  assert.ok(!names.includes("web_search"));
  assert.ok(!names.includes("execute_code"));
});

test("SkillManager parses role frontmatter from disk", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-roles-"));
  const roleDir = join(root, "writer");
  mkdirSync(roleDir);
  writeFileSync(
    join(roleDir, "SKILL.md"),
    [
      "---",
      "name: writer",
      "description: 专利撰写角色",
      "type: role",
      'tools: ["*"]',
      'domains: ["drafting", "quality", "patent"]',
      'omitTools: ["web_search"]',
      "readOnly: false",
      "systemPrompt: 你是专利撰写专家。",
      "---",
      "",
      "# 正文",
    ].join("\n"),
    "utf8",
  );
  const manager = new SkillManager({ pilotHome: join(root, "home"), builtinSkillsRoot: root });
  const result = await manager.list({ projectKey: null });
  const all = [...result.builtin, ...result.user, ...result.project];
  const writer = all.find(s => s.slug === "writer");
  assert.ok(writer, "应扫描到 writer 角色 skill");
  assert.deepEqual(writer?.role?.domains, ["drafting", "quality", "patent"]);
  assert.deepEqual(writer?.role?.omitTools, ["web_search"]);
  assert.equal(writer?.role?.readOnly, false);
  assert.equal(writer?.role?.systemPrompt, "你是专利撰写专家。");
});

test("SkillManager marks plain skills with role null", async () => {
  const root = mkdtempSync(join(tmpdir(), "sati-roles-"));
  const skillDir = join(root, "spike");
  mkdirSync(skillDir);
  writeFileSync(
    join(skillDir, "SKILL.md"),
    ["---", "name: spike", "description: throwaway prototypes", "---", "", "# 正文"].join("\n"),
    "utf8",
  );
  const manager = new SkillManager({ pilotHome: join(root, "home"), builtinSkillsRoot: root });
  const result = await manager.list({ projectKey: null });
  const all = [...result.builtin, ...result.user, ...result.project];
  const spike = all.find(s => s.slug === "spike");
  assert.equal(spike?.role, null);
});

test("bundled example role asset is parseable", async () => {
  const { readFileSync } = await import("node:fs");
  const { parse } = await import("yaml");
  const { resolve } = await import("node:path");
  // 正式角色资产：skills/patent-writer（原 skills/roles/writer 示例已被取代）
  const path = resolve(process.cwd(), "skills", "patent-writer", "SKILL.md");
  const raw = readFileSync(path, "utf8");
  assert.ok(raw.startsWith("---"));
  const end = raw.slice(3).search(/\r?\n---/);
  assert.ok(end > 0);
  const fm = parse(raw.slice(3, 3 + end).replace(/^\r?\n/, "")) as Record<string, unknown>;
  assert.equal(fm.type, "role");
  assert.equal(fm.name, "patent-writer");
  assert.ok(Array.isArray(fm.domains));
  assert.ok(Array.isArray(fm.omitTools));
  assert.equal(typeof fm.systemPrompt, "string");
});
