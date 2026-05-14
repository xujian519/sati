import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InstructionDiscovery } from "../../src/context/instructions/InstructionDiscovery.js";

async function withTmpDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "pilotdeck-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("discover returns empty array when no files exist", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 0);
  });
});

test("discover finds user-level PILOTDECK.md with scope=user", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "PILOTDECK.md"), "Always respond in Chinese.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "user");
    assert.equal(layers[0].content, "Always respond in Chinese.");
    assert.equal(layers[0].path, resolve(pilotHome, "PILOTDECK.md"));
  });
});

test("discover finds project-root PILOTDECK.md with scope=project", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(projectRoot, "PILOTDECK.md"), "Use TypeScript strict mode.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "project");
    assert.equal(layers[0].content, "Use TypeScript strict mode.");
  });
});

test("discover finds .pilotdeck/PILOTDECK.md with scope=project", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    const dotDir = join(projectRoot, ".pilotdeck");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await mkdir(dotDir, { recursive: true });
    await writeFile(join(dotDir, "PILOTDECK.md"), "Nested project instructions.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "project");
    assert.equal(layers[0].path, resolve(dotDir, "PILOTDECK.md"));
  });
});

test("discover loads layers in correct priority order (user < project-root < project-nested)", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    const dotDir = join(projectRoot, ".pilotdeck");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await mkdir(dotDir, { recursive: true });
    await writeFile(join(pilotHome, "PILOTDECK.md"), "user-level");
    await writeFile(join(projectRoot, "PILOTDECK.md"), "project-root");
    await writeFile(join(dotDir, "PILOTDECK.md"), "project-nested");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 3);
    assert.equal(layers[0].scope, "user");
    assert.equal(layers[0].content, "user-level");
    assert.equal(layers[1].scope, "project");
    assert.equal(layers[1].content, "project-root");
    assert.equal(layers[2].scope, "project");
    assert.equal(layers[2].content, "project-nested");
  });
});

test("discover finds PILOTDECK.local.md with scope=local", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(projectRoot, "PILOTDECK.local.md"), "My private overrides.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "local");
    assert.equal(layers[0].content, "My private overrides.");
  });
});

test("discover finds user rules/*.md with scope=user", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    const rulesDir = join(pilotHome, "rules");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, "style.md"), "Use semicolons.");
    await writeFile(join(rulesDir, "SKILL.md"), "Should be excluded.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "user");
    assert.equal(layers[0].content, "Use semicolons.");
  });
});

test("discover finds project .pilotdeck/rules/*.md with scope=project-rules", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    const rulesDir = join(projectRoot, ".pilotdeck", "rules");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await mkdir(rulesDir, { recursive: true });
    await writeFile(join(rulesDir, "naming.md"), "Use camelCase.");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 1);
    assert.equal(layers[0].scope, "project-rules");
    assert.equal(layers[0].content, "Use camelCase.");
  });
});

test("discover skips empty and whitespace-only files", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "PILOTDECK.md"), "");
    await writeFile(join(projectRoot, "PILOTDECK.md"), "   \n  \n  ");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    assert.equal(layers.length, 0);
  });
});

test("discover walks directory chain from projectRoot to cwd", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const subDir = join(projectRoot, "packages", "core");
    const pilotHome = join(dir, "home");
    await mkdir(subDir, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(projectRoot, "PILOTDECK.md"), "root-level");
    await writeFile(join(subDir, "PILOTDECK.md"), "sub-level");

    const discovery = new InstructionDiscovery(projectRoot, subDir, pilotHome);
    const layers = await discovery.discover();
    const projectLayers = layers.filter(l => l.scope === "project");
    assert.equal(projectLayers.length, 2);
    assert.equal(projectLayers[0].content, "root-level");
    assert.equal(projectLayers[1].content, "sub-level");
  });
});

test("discover deduplicates same resolved path", async () => {
  await withTmpDir(async (dir) => {
    const projectRoot = join(dir, "project");
    const pilotHome = join(dir, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(projectRoot, "PILOTDECK.md"), "only once");

    const discovery = new InstructionDiscovery(projectRoot, projectRoot, pilotHome);
    const layers = await discovery.discover();
    const projectLayers = layers.filter(l => l.content === "only once");
    assert.equal(projectLayers.length, 1);
  });
});
