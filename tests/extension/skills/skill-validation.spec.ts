import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validateFromDisk, validateFromManifest } from "../../../src/extension/skills/validation.js";

const SKILL_MD = `---
name: test-skill
description: A skill used to exercise the validation paths end to end.
---

# Test
`;

test("validateFromManifest accepts a well-formed bundle", () => {
  const result = validateFromManifest(SKILL_MD, [
    { relativePath: "SKILL.md", size: 128 },
    { relativePath: "docs/notes.md", size: 64 },
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.stats.fileCount, 2);
  assert.equal(result.stats.totalBytes, 192);
  assert.equal(result.frontmatter?.name, "test-skill");
});

test("validateFromManifest flags unsafe paths and a missing SKILL.md", () => {
  const unsafe = validateFromManifest(SKILL_MD, [{ relativePath: "../escape.txt", size: 1 }]);
  assert.equal(unsafe.ok, false);
  assert.ok(unsafe.hardFails.some(issue => issue.code === "unsafe_path"));

  const missing = validateFromManifest(SKILL_MD, [{ relativePath: "docs/a.md", size: 1 }]);
  assert.equal(missing.ok, false);
  assert.ok(missing.hardFails.some(issue => issue.code === "no_skill_md"));
});

test("validateFromManifest enforces the bundle file-count limit", () => {
  const files = [
    { relativePath: "SKILL.md", size: 1 },
    ...Array.from({ length: 501 }, (_, i) => ({ relativePath: `f${i}.md`, size: 1 })),
  ];
  const result = validateFromManifest(SKILL_MD, files);
  assert.equal(result.ok, false);
  assert.ok(result.hardFails.some(issue => issue.code === "too_many_files"));
});

test("validateFromManifest treats executable-style files as a warning, not a hard fail", () => {
  const result = validateFromManifest(SKILL_MD, [
    { relativePath: "SKILL.md", size: 1 },
    { relativePath: "scripts/run.sh", size: 10 },
  ]);
  assert.equal(result.ok, true);
  assert.ok(result.warnings.some(issue => issue.code === "risky_extension"));
});

test("validateFromDisk validates a real folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-skill-"));
  try {
    await writeFile(join(dir, "SKILL.md"), SKILL_MD);
    const result = await validateFromDisk(dir);
    assert.equal(result.ok, true);
    assert.equal(result.stats.fileCount, 1);
    assert.equal(result.frontmatter?.name, "test-skill");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("validateFromDisk reports a missing source and a folder without SKILL.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "sati-skill-"));
  try {
    const missingSource = await validateFromDisk(join(dir, "does-not-exist"));
    assert.equal(missingSource.ok, false);
    assert.ok(missingSource.hardFails.some(issue => issue.code === "source_missing"));

    const noSkillMd = await validateFromDisk(dir);
    assert.equal(noSkillMd.ok, false);
    assert.ok(noSkillMd.hardFails.some(issue => issue.code === "no_skill_md"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
