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

test("roleFromSkill warns when law_search exposed without legal domain", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    roleFromSkill(
      roleSkillSummary({
        role: { tools: ["law_search", "web_search"], domains: ["patent"], readOnly: false },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warns.some(w => w.includes("law_search") && w.includes("legal")),
    `应输出域缺失 warn: ${warns.join("; ")}`,
  );
});

test("roleFromSkill no warn when required domain present", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    roleFromSkill(
      roleSkillSummary({
        role: { tools: ["law_search"], domains: ["legal", "patent"], readOnly: false },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(!warns.some(w => w.includes("law_search")), `不应 warn: ${warns.join("; ")}`);
});

test("roleFromSkill warns on wildcard tools without legal domain", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    roleFromSkill(
      roleSkillSummary({
        role: { tools: ["*"], domains: ["patent"], readOnly: false },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warns.some(w => w.includes("law_search") && w.includes("legal")),
    `通配工具也应触发 warn: ${warns.join("; ")}`,
  );
});

test("roleFromSkill no warn when domains undefined (工具天然可见)", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    roleFromSkill(
      roleSkillSummary({
        role: { tools: ["law_search"], readOnly: false },
      }),
    );
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warns.length, 0, `未裁剪角色不应 warn: ${warns.join("; ")}`);
});

test("roleFromContribution warns on paper_search without literature domain", () => {
  const warns: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  try {
    roleFromContribution({
      name: "lit-searcher",
      description: "文献检索",
      path: "/tmp/lit-searcher/SKILL.md",
      role: { tools: ["paper_search"], domains: ["search"], readOnly: true },
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(
    warns.some(w => w.includes("paper_search") && w.includes("literature")),
    `应输出文献域缺失 warn: ${warns.join("; ")}`,
  );
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

test("roleFromSkill compiles knowledge declaration into systemPromptSuffix", () => {
  const definition = roleFromSkill(
    roleSkillSummary({
      role: {
        tools: ["*"],
        domains: ["patent", "filesystem"],
        readOnly: false,
        systemPrompt: "你是专利审查助手。",
        knowledge: {
          cards: ["专利实务/创造性/创造性-概述与三步法框架", "专利实务/创造性/创造性-原理-技术启示的认定"],
          requireCaseSearch: true,
          requireLawSearch: true,
        },
      },
    }),
  );
  assert.ok(definition !== null);
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.startsWith("你是专利审查助手。"), "基础 systemPrompt 应保留");
  assert.ok(suffix.includes("【知识接线】"), "应编译知识接线段");
  assert.ok(suffix.includes("patent_wiki_search"), "应包含 wiki 卡片检索指令");
  assert.ok(suffix.includes("创造性-概述与三步法框架"), "应包含必查卡片");
  assert.ok(suffix.includes("patent_case_search"), "应包含判例检索指令");
  assert.ok(suffix.includes("law_search"), "应包含法条核验指令");
});

test("roleFromSkill knowledge without optional flags only emits cards", () => {
  const definition = roleFromSkill(
    roleSkillSummary({
      role: {
        domains: ["patent"],
        systemPrompt: "你是检索专家。",
        knowledge: { cards: ["专利实务/新颖性/新颖性-原理-单独对比原则"] },
      },
    }),
  );
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.includes("【知识接线】"));
  assert.ok(suffix.includes("单独对比原则"));
  assert.ok(!suffix.includes("patent_case_search"), "未声明 requireCaseSearch 不应输出判例指令");
  assert.ok(!suffix.includes("law_search"), "未声明 requireLawSearch 不应输出法条指令");
});

test("roleFromSkill without knowledge keeps systemPrompt unchanged", () => {
  const definition = roleFromSkill(roleSkillSummary());
  assert.equal(definition?.systemPromptSuffix, "你是专利撰写专家。");
  assert.ok(!definition?.systemPromptSuffix.includes("【知识接线】"));
});

test("roleFromContribution compiles knowledge declaration", () => {
  const contribution: PluginSkillContribution = {
    name: "oa-writer",
    description: "OA 答复",
    path: "/tmp/oa-writer/SKILL.md",
    role: {
      domains: ["patent", "legal"],
      readOnly: false,
      systemPrompt: "你是 OA 答复专家。",
      knowledge: { cards: ["专利实务/修改/修改-修改依据与超范围判断"], requireLawSearch: true },
    },
  };
  const definition = roleFromContribution(contribution);
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.includes("【知识接线】"));
  assert.ok(suffix.includes("修改依据与超范围判断"));
  assert.ok(suffix.includes("law_search"));
  assert.ok(!suffix.includes("patent_case_search"));
});

test("roleFromSkill maps output schema/template and compiles 输出格式", () => {
  const schema = { type: "object", required: ["新颖性结论", "证据段", "风险"], properties: {} };
  const definition = roleFromSkill(
    roleSkillSummary({
      role: {
        domains: ["patent"],
        systemPrompt: "你是检索专家。",
        output: {
          schema,
          template: "## 结论\n\n## 证据\n\n## 风险",
        },
      },
    }),
  );
  assert.ok(definition !== null);
  assert.equal(definition?.outputSchema, schema, "outputSchema 应透传");
  assert.equal(definition?.outputTemplate, "## 结论\n\n## 证据\n\n## 风险", "outputTemplate 应透传");
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.startsWith("你是检索专家。"), "基础 systemPrompt 应保留");
  assert.ok(suffix.includes("【输出格式】"), "应编译输出格式段");
  assert.ok(suffix.includes("新颖性结论"), "应包含 schema.required 字段");
  assert.ok(suffix.includes("风险"), "应包含多个 required 字段");
  assert.ok(suffix.includes("缺任一字段即视为结构化不足"), "应说明缺字段即结构化不足");
  assert.ok(suffix.includes("## 证据"), "应包含输出骨架模板");
});

test("roleFromSkill output without template only emits required fields", () => {
  const definition = roleFromSkill(
    roleSkillSummary({
      role: {
        domains: ["patent"],
        systemPrompt: "你是检索专家。",
        output: { schema: { type: "object", required: ["新颖性结论"] } },
      },
    }),
  );
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.includes("【输出格式】"));
  assert.ok(suffix.includes("新颖性结论"));
  assert.ok(!suffix.includes("【骨架】"), "未声明 template 不应输出骨架");
});

test("roleFromSkill without output keeps systemPrompt unchanged", () => {
  const definition = roleFromSkill(roleSkillSummary());
  assert.equal(definition?.systemPromptSuffix, "你是专利撰写专家。");
  assert.ok(!definition?.systemPromptSuffix.includes("【输出格式】"));
  assert.equal(definition?.outputSchema, undefined);
  assert.equal(definition?.outputTemplate, undefined);
});

test("roleFromContribution maps output schema/template", () => {
  const contribution: PluginSkillContribution = {
    name: "oa-writer",
    description: "OA 答复",
    path: "/tmp/oa-writer/SKILL.md",
    role: {
      domains: ["patent"],
      systemPrompt: "你是 OA 答复专家。",
      output: { schema: { type: "object", required: ["答复理由"] } },
    },
  };
  const definition = roleFromContribution(contribution);
  const suffix = definition?.systemPromptSuffix ?? "";
  assert.ok(suffix.includes("【输出格式】"));
  assert.ok(suffix.includes("答复理由"));
  assert.ok(definition?.outputSchema !== undefined, "outputSchema 应填充");
});

test("rolesFromSkills collects role definitions with output contract", () => {
  const roles = rolesFromSkills([
    roleSkillSummary({ role: { tools: ["*"], domains: ["patent"], output: { schema: { required: ["结论"] } } } }),
  ]);
  assert.equal(roles.length, 1);
  assert.deepEqual(roles[0]?.outputSchema, { required: ["结论"] });
});
