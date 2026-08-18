import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager } from "../../../src/extension/skills/index.js";

test("SkillManager parses optional HTML template metadata from frontmatter", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-template-meta-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const builtinSkillsRoot = join(root, "bundled-skills");
    const skillDir = join(builtinSkillsRoot, "html-data-report");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: html-data-report
description: A data report template
mode: data-report
scenario: finance
surface: long-page
preview: example.html
design_system: sati-html
---
# Data Report
`,
      "utf8",
    );

    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
    const result = await manager.list({ projectKey: null });
    const skill = result.builtin.find(entry => entry.slug === "html-data-report");
    assert.ok(skill);
    assert.deepEqual(skill.template, {
      mode: "data-report",
      scenario: "finance",
      surface: "long-page",
      preview: "example.html",
      designSystem: "sati-html",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SkillManager ignores invalid template metadata values and unsafe preview paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-template-meta-invalid-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const builtinSkillsRoot = join(root, "bundled-skills");
    const skillDir = join(builtinSkillsRoot, "html-invalid");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: html-invalid
description: Invalid metadata
mode: not-a-real-mode
scenario: mystery
surface: super-wide
preview: ../secret.html
design_system: ""
---
# Invalid
`,
      "utf8",
    );

    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
    const result = await manager.list({ projectKey: null });
    const skill = result.builtin.find(entry => entry.slug === "html-invalid");
    assert.ok(skill);
    assert.equal(skill.template?.mode, undefined);
    assert.equal(skill.template?.scenario, undefined);
    assert.equal(skill.template?.surface, undefined);
    assert.equal(skill.template?.preview, undefined);
    assert.equal(skill.template?.designSystem, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
