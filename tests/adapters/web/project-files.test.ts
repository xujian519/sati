import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProjectFileService,
  WorkspaceBoundaryError,
} from "../../../src/adapters/web/projectFiles.js";

function makeWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "pilotdeck-fs-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  return dir;
}

test("readTree lists files relative to project root", async () => {
  const root = makeWorkspace();
  try {
    const service = new ProjectFileService({ projectRoot: root });
    const result = await service.readTree(".");
    const paths = result.entries.map((entry) => entry.path).sort();
    assert.deepEqual(paths, ["README.md", "src"]);
    const directories = result.entries.filter((entry) => entry.type === "directory");
    assert.equal(directories.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFile returns text content for known extensions", async () => {
  const root = makeWorkspace();
  try {
    const service = new ProjectFileService({ projectRoot: root });
    const result = await service.readFile("README.md");
    assert.equal(result.encoding, "utf8");
    assert.equal(result.content, "# hi\n");
    assert.equal(result.path, "README.md");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("readFile rejects paths that escape workspace root", async () => {
  const root = makeWorkspace();
  try {
    const service = new ProjectFileService({ projectRoot: root });
    await assert.rejects(() => service.readFile("../etc/passwd"), WorkspaceBoundaryError);
    await assert.rejects(() => service.readFile("/etc/passwd"), WorkspaceBoundaryError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeFile creates parent directories", async () => {
  const root = makeWorkspace();
  try {
    const service = new ProjectFileService({ projectRoot: root });
    await service.writeFile("nested/dir/file.txt", "hello");
    const read = await service.readFile("nested/dir/file.txt");
    assert.equal(read.content, "hello");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeFile rejects escaping paths", async () => {
  const root = makeWorkspace();
  try {
    const service = new ProjectFileService({ projectRoot: root });
    await assert.rejects(() => service.writeFile("../oops.txt", "x"), WorkspaceBoundaryError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
