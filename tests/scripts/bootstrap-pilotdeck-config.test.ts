import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("bootstrap writes config and symlinks repo skills on first init", async () => {
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
      const targetPath = path.join(fixture.pilotHome, "skills", skill.slug);
      assert.equal(lstatSync(targetPath).isSymbolicLink(), true, `${skill.slug} should be a symlink`);
      assert.equal(realpathSync(targetPath), realpathSync(skill.sourcePath));
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

    const targetPath = path.join(fixture.pilotHome, "skills", "xhs-orchestrator");
    assert.equal(lstatSync(targetPath).isSymbolicLink(), true);
    assert.equal(realpathSync(targetPath), realpathSync(fixture.skills[0].sourcePath));
    assert.equal(readFileSync(path.join(fixture.pilotHome, "pilotdeck.yaml"), "utf8"), "schemaVersion: 1\n");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("bootstrap keeps existing targets and links the remaining repo skills", async () => {
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
    const linkedPath = path.join(fixture.pilotHome, "skills", "xhs-publish");
    assert.equal(lstatSync(linkedPath).isSymbolicLink(), true);
    assert.equal(realpathSync(linkedPath), realpathSync(fixture.skills[1].sourcePath));
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
    assert.equal(lstatSync(targetPath).isSymbolicLink(), true);
    assert.equal(realpathSync(targetPath), realpathSync(fixture.skills[0].sourcePath));
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
    await writeFile(path.join(sourcePath, "notes.md"), "supporting content\n", "utf8");
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

function pathExists(targetPath: string): boolean {
  try {
    lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
