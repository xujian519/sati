import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { SkillManager } from "../../../src/extension/skills/SkillManager.js";

async function withManager<T>(fn: (manager: SkillManager, pilotHome: string) => Promise<T>): Promise<T> {
  const pilotHome = await mkdtemp(join(tmpdir(), "pilotdeck-skills-test-"));
  try {
    return await fn(new SkillManager({ pilotHome }), pilotHome);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
}

function validateSkillMd(manager: SkillManager, skillMdContent: string) {
  return manager.validate({
    skillMdContent,
    files: [{ relativePath: "SKILL.md", size: Buffer.byteLength(skillMdContent) }],
  });
}

test("skill validation accepts standard YAML frontmatter", async () => {
  await withManager(async (manager) => {
    const result = await validateSkillMd(
      manager,
      [
        "---",
        "name: pptx",
        "description: Work with PowerPoint decks and .pptx files.",
        "---",
        "",
        "# PPTX",
      ].join("\n"),
    );

    assert.equal(result.ok, true);
    assert.equal(result.frontmatter?.name, "pptx");
    assert.equal(result.frontmatter?.description, "Work with PowerPoint decks and .pptx files.");
    assert.equal(result.warnings.some((w) => w.code === "frontmatter_compat_fallback"), false);
  });
});

test("skill validation accepts OpenClaw-style description block without YAML spacing", async () => {
  await withManager(async (manager) => {
    const result = await validateSkillMd(
      manager,
      [
        "---",
        "name: pptx",
        "description:>",
        "当涉及 .pptx 文件时使用此技能。",
        "编辑、修改或更新现有演示文稿。",
        "---",
        "",
        "# PPTX",
      ].join("\n"),
    );

    assert.equal(result.ok, true);
    assert.equal(result.frontmatter?.name, "pptx");
    assert.equal(
      result.frontmatter?.description,
      "当涉及 .pptx 文件时使用此技能。\n编辑、修改或更新现有演示文稿。",
    );
    assert.equal(result.warnings.some((w) => w.code === "frontmatter_compat_fallback"), true);
  });
});

test("skill validation still fails when required frontmatter fields are missing", async () => {
  await withManager(async (manager) => {
    const result = await validateSkillMd(
      manager,
      [
        "---",
        "description: Work with PowerPoint decks and .pptx files.",
        "---",
        "",
        "# PPTX",
      ].join("\n"),
    );

    assert.equal(result.ok, false);
    assert.equal(
      result.hardFails.some((issue) => issue.code === "frontmatter_missing_name"),
      true,
    );
  });
});
