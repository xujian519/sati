import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("bootstrap writes config and copies repo skills on first init", async () => {
  const fixture = await createBootstrapFixture({
    skills: [
      { category: "xiaohongshu", slug: "xhs-orchestrator" },
      { category: "xiaohongshu", slug: "xhs-publish" },
    ],
  });
  try {
    runBootstrap(fixture.repoRoot, fixture.pilotHome);

    const configPath = path.join(fixture.pilotHome, "pilotdeck.yaml");
    assert.match(readFileSync(configPath, "utf8"), /PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE/);

    for (const skill of fixture.skills) {
      assertCopiedSkill(path.join(fixture.pilotHome, "skills", skill.slug), skill);
    }
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("bootstrap syncs repo skills even when config already exists", async () => {
  const fixture = await createBootstrapFixture({
    skills: [{ category: "xiaohongshu", slug: "xhs-orchestrator" }],
  });
  try {
    await mkdir(fixture.pilotHome, { recursive: true });
    await writeFile(path.join(fixture.pilotHome, "pilotdeck.yaml"), "schemaVersion: 1\n", "utf8");

    runBootstrap(fixture.repoRoot, fixture.pilotHome);

    assertCopiedSkill(path.join(fixture.pilotHome, "skills", "xhs-orchestrator"), fixture.skills[0]);
    assert.equal(readFileSync(path.join(fixture.pilotHome, "pilotdeck.yaml"), "utf8"), "schemaVersion: 1\n");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("bootstrap keeps existing targets and copies the remaining repo skills", async () => {
  const fixture = await createBootstrapFixture({
    skills: [
      { category: "xiaohongshu", slug: "xhs-orchestrator" },
      { category: "xiaohongshu", slug: "xhs-publish" },
    ],
  });
  try {
    const existingPath = path.join(fixture.pilotHome, "skills", "xhs-orchestrator");
    await mkdir(existingPath, { recursive: true });
    await writeFile(path.join(existingPath, "SKILL.md"), "existing", "utf8");

    runBootstrap(fixture.repoRoot, fixture.pilotHome);

    assert.equal(lstatSync(existingPath).isDirectory(), true, "existing target should remain untouched");
    assert.equal(readFileSync(path.join(existingPath, "SKILL.md"), "utf8"), "existing");
    assertCopiedSkill(path.join(fixture.pilotHome, "skills", "xhs-publish"), fixture.skills[1]);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("bootstrap succeeds when the repo has no skills directory", async () => {
  const fixture = await createBootstrapFixture({ skills: [] });
  try {
    runBootstrap(fixture.repoRoot, fixture.pilotHome);

    assert.equal(pathExists(path.join(fixture.pilotHome, "pilotdeck.yaml")), true);
    assert.equal(pathExists(path.join(fixture.repoRoot, "skills")), false);
    assert.equal(pathExists(path.join(fixture.pilotHome, "skills")), false);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("bootstrap skips duplicate leaf slugs across repo skills", async () => {
  const fixture = await createBootstrapFixture({
    skills: [
      { category: "one", slug: "shared-skill" },
      { category: "two", slug: "shared-skill" },
    ],
  });
  try {
    runBootstrap(fixture.repoRoot, fixture.pilotHome);

    const targetPath = path.join(fixture.pilotHome, "skills", "shared-skill");
    assertCopiedSkill(targetPath, fixture.skills[0]);
    assert.equal(readFileSync(path.join(targetPath, "notes.md"), "utf8"), "note from one/shared-skill\n");
  } finally {
    cleanupFixture(fixture.root);
  }
});

type SkillFixture = {
  category: string;
  slug: string;
  sourcePath: string;
};

async function createBootstrapFixture(input: {
  skills: Array<{ category: string; slug: string }>;
}): Promise<{
  root: string;
  repoRoot: string;
  pilotHome: string;
  skills: SkillFixture[];
}> {
  const root = mkdtempSync(path.join(os.tmpdir(), "pilotdeck-bootstrap-"));
  const repoRoot = path.join(root, "repo");
  const pilotHome = path.join(root, "pilot-home");
  await mkdir(path.join(repoRoot, "scripts"), { recursive: true });
  await writeFile(
    path.join(repoRoot, "scripts", "bootstrap-pilotdeck-config.mjs"),
    readFileSync(path.join(process.cwd(), "scripts", "bootstrap-pilotdeck-config.mjs"), "utf8"),
    "utf8",
  );

  const skills: SkillFixture[] = [];
  for (const entry of input.skills) {
    const sourcePath = path.join(repoRoot, "skills", entry.category, entry.slug);
    await mkdir(sourcePath, { recursive: true });
    await writeFile(path.join(sourcePath, "SKILL.md"), `# ${entry.slug}\n`, "utf8");
    await writeFile(path.join(sourcePath, "notes.md"), `note from ${entry.category}/${entry.slug}\n`, "utf8");
    skills.push({ ...entry, sourcePath });
  }

  return { root, repoRoot, pilotHome, skills };
}

function runBootstrap(repoRoot: string, pilotHome: string): string {
  return execFileSync("node", [path.join(repoRoot, "scripts", "bootstrap-pilotdeck-config.mjs")], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PILOT_HOME: pilotHome,
      PILOTDECK_SKIP_BOOTSTRAP: "",
    },
    encoding: "utf8",
  });
}

function cleanupFixture(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

function assertCopiedSkill(targetPath: string, skill: SkillFixture): void {
  assert.equal(existsSync(targetPath), true, `${skill.slug} should exist`);
  assert.equal(lstatSync(targetPath).isDirectory(), true, `${skill.slug} should be copied as a directory`);
  assert.equal(lstatSync(targetPath).isSymbolicLink(), false, `${skill.slug} should not be a symlink`);
  assert.equal(
    readFileSync(path.join(targetPath, "SKILL.md"), "utf8"),
    readFileSync(path.join(skill.sourcePath, "SKILL.md"), "utf8"),
  );
  assert.equal(
    readFileSync(path.join(targetPath, "notes.md"), "utf8"),
    readFileSync(path.join(skill.sourcePath, "notes.md"), "utf8"),
  );
}

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
