import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateSkillsToPilotDeck } from "../../src/extension/skills/index.js";

test("dry-runs custom skill migration without writing to PilotDeck", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skills-migrate-"));
  const sourceRoot = join(root, "source-skills");
  const pilotHome = join(root, "pilot-home");
  await writeSkill(sourceRoot, "alpha", "Alpha skill");

  const report = await migrateSkillsToPilotDeck({
    pilotHome,
    include: [],
    customSources: [sourceRoot],
  });

  assert.equal(report.mode, "dry-run");
  assert.equal(report.summary.would_migrate, 1);
  assert.equal(report.items[0]?.slug, "alpha");
  await assert.rejects(readFile(join(pilotHome, "skills", "alpha", "SKILL.md"), "utf8"));
});

test("executes custom skill migration into PilotDeck user skills", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skills-migrate-"));
  const sourceRoot = join(root, "source-skills");
  const pilotHome = join(root, "pilot-home");
  await writeSkill(sourceRoot, "alpha", "Alpha skill");

  const report = await migrateSkillsToPilotDeck({
    pilotHome,
    include: [],
    customSources: [sourceRoot],
    execute: true,
  });

  assert.equal(report.summary.migrated, 1);
  assert.match(await readFile(join(pilotHome, "skills", "alpha", "SKILL.md"), "utf8"), /Alpha skill/);
});

test("renames migrated skills when the destination slug exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skills-migrate-"));
  const sourceRoot = join(root, "source-skills");
  const pilotHome = join(root, "pilot-home");
  await writeSkill(sourceRoot, "alpha", "Alpha skill");
  await writeSkill(join(pilotHome, "skills"), "alpha", "Existing skill");

  const report = await migrateSkillsToPilotDeck({
    pilotHome,
    include: [],
    customSources: [sourceRoot],
    execute: true,
    conflictMode: "rename",
  });

  assert.equal(report.summary.migrated, 1);
  assert.equal(report.items[0]?.slug, "alpha-imported");
  assert.match(await readFile(join(pilotHome, "skills", "alpha-imported", "SKILL.md"), "utf8"), /Alpha skill/);
});

async function writeSkill(parent: string, slug: string, name: string): Promise<void> {
  const dir = join(parent, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Test skill\n---\n\n# ${name}\n`,
    "utf8",
  );
}
