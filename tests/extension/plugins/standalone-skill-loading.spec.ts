import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPluginCommandName } from "../../../src/extension/plugins/loading/PluginCommandLoader.js";
import { loadSkillFromPath } from "../../../src/extension/plugins/loading/PluginLoader.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

async function writeSkill(skillDir: string, name: string, description: string, body: string): Promise<void> {
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

test("standalone skills expose only their slug without a parent-directory namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-standalone-skill-"));
  try {
    const skillDir = join(root, "docx");
    await writeSkill(skillDir, "docx", "Create and edit Word documents.", "# DOCX skill");
    await mkdir(join(skillDir, "references"), { recursive: true });
    await writeFile(join(skillDir, "references", "workflows.md"), "# Workflows\n", "utf8");

    const loaded = await loadSkillFromPath(skillDir, "global");
    assert.equal(loaded.name, "docx");
    assert.equal(loaded.skills?.length, 1);
    assert.equal(loaded.skills?.[0]?.name, "docx");
    assert.equal(loaded.skills?.[0]?.isSkill, true);
    assert.match(loaded.skills?.[0]?.content ?? "", /# DOCX skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter 多行 systemPrompt（|- 块）完整解析，不含字面量 '|-'", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-frontmatter-"));
  try {
    const skillDir = join(root, "analyzer");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: analyzer\ndescription: Analyze patents.\nsystemPrompt: |-\n  你是专利分析师。\n  只输出结论。\n---\n\n# body\n`,
      "utf8",
    );
    const loaded = await loadSkillFromPath(skillDir, "global");
    const skill = loaded.skills?.[0];
    assert.equal(skill?.name, "analyzer");
    assert.equal(
      skill?.frontmatter.systemPrompt,
      "你是专利分析师。\n只输出结论。",
      "多行块完整解析（|- 为 strip 折叠，剥离结尾换行）",
    );
    assert.equal(skill?.frontmatter.description, "Analyze patents.");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frontmatter 数组字段（domains/tools）保留为数组", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-domains-"));
  try {
    const skillDir = join(root, "searcher");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---\nname: searcher\ndescription: Search.\ndomains: [patent, literature]\ntools: [paper_search, patent_search]\n---\n\n# body\n`,
      "utf8",
    );
    const loaded = await loadSkillFromPath(skillDir, "global");
    const skill = loaded.skills?.[0];
    assert.deepEqual(skill?.frontmatter.domains, ["patent", "literature"]);
    assert.deepEqual(skill?.frontmatter.tools, ["paper_search", "patent_search"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("畸形 frontmatter 降级不抛错：无闭合围栏 / 非法 yaml 均为空对象 + 全文内容", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-broken-"));
  try {
    const skillDir = join(root, "broken");
    await mkdir(skillDir, { recursive: true });
    // 无闭合围栏：整篇视为内容，frontmatter 为空
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: broken\n# 无闭合围栏\n\n# body\n", "utf8");
    let loaded = await loadSkillFromPath(skillDir, "global");
    assert.ok(loaded.skills, "无闭合围栏 → 不抛错，frontmatter 为空，全文为内容");
    assert.deepEqual(loaded.skills?.[0]?.frontmatter, {});
    assert.match(loaded.skills?.[0]?.content ?? "", /# 无闭合围栏/);

    // 闭合围栏存在但 yaml 不可解析：空对象 + 正文保留
    await writeFile(join(skillDir, "SKILL.md"), "---\nname: [unclosed\n---\n\n# body\n", "utf8");
    loaded = await loadSkillFromPath(skillDir, "global");
    assert.ok(loaded.skills, "非法 yaml → 不抛错");
    assert.deepEqual(loaded.skills?.[0]?.frontmatter, {});
    assert.match(loaded.skills?.[0]?.content ?? "", /# body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("空 frontmatter（围栏内仅空行）解析为空对象，正文保留（end+5 偏移契约）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-empty-"));
  try {
    const skillDir = join(root, "empty-fm");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\n\n---\n\n# body\n", "utf8");
    const loaded = await loadSkillFromPath(skillDir, "global");
    assert.deepEqual(loaded.skills?.[0]?.frontmatter, {});
    assert.match(loaded.skills?.[0]?.content ?? "", /# body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("纯标量 frontmatter 走非对象守卫：解析为空对象，正文保留", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-scalar-"));
  try {
    const skillDir = join(root, "scalar-fm");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "---\nplain\n---\n\n# body\n", "utf8");
    const loaded = await loadSkillFromPath(skillDir, "global");
    assert.deepEqual(loaded.skills?.[0]?.frontmatter, {});
    assert.match(loaded.skills?.[0]?.content ?? "", /# body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("含冒号值行 frontmatter 触发 yaml 严格解析错误 → 整体降级为空对象且不抛错", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-yaml-colon-"));
  try {
    const skillDir = join(root, "colon-fm");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: t\ndescription: Handles OA: responses.\n---\n\n# body\n",
      "utf8",
    );
    const loaded = await loadSkillFromPath(skillDir, "global");
    assert.ok(loaded.skills, "单行非法（Nested mappings）→ 整体降级，不抛错");
    assert.deepEqual(loaded.skills?.[0]?.frontmatter, {});
    assert.match(loaded.skills?.[0]?.content ?? "", /# body/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a plugin skill directory used as the configured base never derives a parent namespace", () => {
  const skillDir = join("tmp", "office", "skills", "docx");
  assert.equal(getPluginCommandName("office", join(skillDir, "SKILL.md"), skillDir), "office:docx");
});

test("standalone skill precedence is project > user > builtin without legacy aliases", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-precedence-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const builtinSkillsRoot = join(root, "bundled-skills");
    await writeSkill(
      join(builtinSkillsRoot, "docx"),
      "docx",
      "Built-in DOCX skill description.",
      "# Built-in DOCX skill",
    );
    await writeSkill(
      join(pilotHome, "skills", "docx"),
      "docx",
      "Global DOCX skill description.",
      "# Global DOCX skill",
    );
    await writeSkill(
      join(projectRoot, ".sati", "skills", "docx"),
      "docx",
      "Project DOCX skill description.",
      "# Project DOCX skill",
    );

    const pluginDir = join(pilotHome, "plugins", "office");
    await mkdir(join(pluginDir, "skills", "docx"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "office", version: "1.0.0" }), "utf8");
    await writeSkill(
      join(pluginDir, "skills", "docx"),
      "docx",
      "Plugin DOCX skill description.",
      "# Plugin DOCX skill",
    );

    const runtime = new PluginRuntime({ projectRoot, pilotHome, builtinSkillsRoot });
    await runtime.refresh();

    const docxSkills = runtime.getAllSkills().filter(skill => skill.name.includes("docx"));
    assert.deepEqual(docxSkills.map(skill => skill.name).sort(), ["docx", "office:docx"]);
    assert.equal(docxSkills.find(skill => skill.name === "docx")?.description, "Project DOCX skill description.");
    assert.equal(
      docxSkills.find(skill => skill.name === "docx")?.path,
      join(projectRoot, ".sati", "skills", "docx", "SKILL.md"),
    );
    assert.equal(
      docxSkills.find(skill => skill.name === "office:docx")?.path,
      join(pluginDir, "skills", "docx", "SKILL.md"),
    );

    assert.match((await runtime.loadSkillPrompt("docx")) ?? "", /# Project DOCX skill/);
    assert.equal(await runtime.loadSkillPrompt("docx:..:docx"), undefined);
    assert.equal(await runtime.loadSkillPrompt("docx:docx"), undefined);
    assert.match((await runtime.loadSkillPrompt("office:docx")) ?? "", /# Plugin DOCX skill/);

    await rm(join(projectRoot, ".sati", "skills", "docx"), { recursive: true, force: true });
    await runtime.refresh();
    assert.equal(
      runtime.getAllSkills().find(skill => skill.name === "docx")?.description,
      "Global DOCX skill description.",
    );
    assert.equal(
      runtime.getAllSkills().find(skill => skill.name === "docx")?.path,
      join(pilotHome, "skills", "docx", "SKILL.md"),
    );
    assert.match((await runtime.loadSkillPrompt("docx")) ?? "", /# Global DOCX skill/);

    await rm(join(pilotHome, "skills", "docx"), { recursive: true, force: true });
    await runtime.refresh();
    assert.equal(
      runtime.getAllSkills().find(skill => skill.name === "docx")?.description,
      "Built-in DOCX skill description.",
    );
    assert.equal(
      runtime.getAllSkills().find(skill => skill.name === "docx")?.path,
      join(builtinSkillsRoot, "docx", "SKILL.md"),
    );
    assert.match((await runtime.loadSkillPrompt("docx")) ?? "", /# Built-in DOCX skill/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
