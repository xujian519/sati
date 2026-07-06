import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SkillManager } from "../../../src/extension/skills/index.js";
import { SkillManagerError } from "../../../src/extension/skills/SkillManager.js";

async function writeSkill(dir: string, name: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} description\n---\n\nUse ${name}.\n`);
}

test("scan finds child skill folders and direct skill folders", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-scan-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const parent = join(root, "parent");
    const skillA = join(parent, "skill-a");
    const emptyChild = join(parent, "empty-child");
    await writeSkill(skillA, "Skill A");
    await mkdir(emptyChild, { recursive: true });

    const manager = new SkillManager({ pilotHome });

    const parentScan = await manager.scan({ parentPath: parent });
    assert.deepEqual(parentScan.folders.map((folder) => ({ folderName: folder.folderName, hasSkillMd: folder.hasSkillMd })), [
      { folderName: "skill-a", hasSkillMd: true },
      { folderName: "empty-child", hasSkillMd: false },
    ]);

    const directScan = await manager.scan({ parentPath: skillA });
    assert.equal(directScan.folders[0]?.folderName, "skill-a");
    assert.equal(directScan.folders[0]?.hasSkillMd, true);
    assert.equal(directScan.folders[0]?.sourcePath, skillA);
    assert.equal(directScan.folders[0]?.name, "Skill A");

    const imported = await manager.import({ sourcePath: directScan.folders[0]!.sourcePath, scope: "user", mode: "copy" });
    assert.equal(imported.ok, true);
    assert.equal(imported.slug, "skill-a");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan returns an empty list for an empty non-skill directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-scan-empty-"));
  try {
    const manager = new SkillManager({ pilotHome: join(root, "pilot-home") });
    const scan = await manager.scan({ parentPath: root });
    assert.deepEqual(scan.folders, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scan rejects file paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-scan-file-"));
  try {
    const filePath = join(root, "SKILL.md");
    await writeFile(filePath, "---\nname: File\n---\n");
    const manager = new SkillManager({ pilotHome: join(root, "pilot-home") });

    await assert.rejects(
      () => manager.scan({ parentPath: filePath }),
      (error) => error instanceof SkillManagerError && error.code === "not_directory",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
