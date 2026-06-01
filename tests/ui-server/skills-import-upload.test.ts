import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

const require = createRequire(import.meta.url);
const { moveDirectoryAcrossDevicesSafe } = require(
  join(process.cwd(), "ui/server/utils/fileMoves.js"),
) as {
  moveDirectoryAcrossDevicesSafe: (
    sourceDir: string,
    targetDir: string,
    fsImpl?: {
      rename: (sourceDir: string, targetDir: string) => Promise<void>;
      cp: (sourceDir: string, targetDir: string, options: unknown) => Promise<void>;
      rm: (sourceDir: string, options: unknown) => Promise<void>;
    },
  ) => Promise<void>;
};

test("moveDirectoryAcrossDevicesSafe moves a staged skill directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-skill-move-"));
  const sourceDir = join(root, "source");
  const nestedDir = join(sourceDir, "assets");
  const targetDir = join(root, "target-skill");

  try {
    await mkdir(nestedDir, { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "---\nname: test\n---\n");
    await writeFile(join(nestedDir, "example.txt"), "asset");

    await moveDirectoryAcrossDevicesSafe(sourceDir, targetDir);

    assert.equal(await readFile(join(targetDir, "SKILL.md"), "utf8"), "---\nname: test\n---\n");
    assert.equal(await readFile(join(targetDir, "assets", "example.txt"), "utf8"), "asset");
    await assert.rejects(readFile(join(sourceDir, "SKILL.md"), "utf8"), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("moveDirectoryAcrossDevicesSafe falls back to copy/remove on EXDEV", async () => {
  const calls: string[] = [];
  const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
  const fsImpl = {
    async rename() {
      calls.push("rename");
      throw exdev;
    },
    async cp(_sourceDir: string, _targetDir: string, options: unknown) {
      calls.push("cp");
      assert.deepEqual(options, { recursive: true, force: false, errorOnExist: true });
    },
    async rm(_sourceDir: string, options: unknown) {
      calls.push("rm");
      assert.deepEqual(options, { recursive: true, force: true });
    },
  };

  await moveDirectoryAcrossDevicesSafe("/tmp/skill-upload-x", "/root/.pilotdeck/skills/demo", fsImpl);

  assert.deepEqual(calls, ["rename", "cp", "rm"]);
});

test("moveDirectoryAcrossDevicesSafe rethrows non-EXDEV rename errors", async () => {
  const permissionError = Object.assign(new Error("permission denied"), { code: "EACCES" });
  const fsImpl = {
    async rename() {
      throw permissionError;
    },
    async cp() {
      assert.fail("cp should not run for non-EXDEV errors");
    },
    async rm() {
      assert.fail("rm should not run for non-EXDEV errors");
    },
  };

  await assert.rejects(
    moveDirectoryAcrossDevicesSafe("/tmp/skill-upload-x", "/root/.pilotdeck/skills/demo", fsImpl),
    { code: "EACCES" },
  );
});
