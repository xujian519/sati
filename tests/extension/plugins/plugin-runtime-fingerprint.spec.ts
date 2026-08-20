import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";

/**
 * M6 指纹缓存（PluginRuntime.refreshWithReport）：
 *  - 首次 refresh 加载磁盘插件；
 *  - 文件未变且 TTL 内二次 refresh → 命中缓存（next 引用相同、added/removed 为空）；
 *  - SKILL.md 内容编辑（目录 mtime 不变）→ 指纹变化 → 重扫，新内容立即可见；
 *  - 插件目录增删 → 指纹变化 → 重扫。
 */

async function writeSkill(projectRoot: string, name: string, description: string, body: string): Promise<void> {
  const skillDir = join(projectRoot, ".sati", "skills", name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    "utf8",
  );
}

function makeRuntime(projectRoot: string, pilotHome: string): PluginRuntime {
  return new PluginRuntime({ projectRoot, pilotHome });
}

function skillContent(runtime: PluginRuntime, name: string): string | undefined {
  const skill = runtime.snapshot().find(plugin => plugin.name === name);
  return skill?.skills?.[0]?.content;
}

test("M6: 首次 refresh 加载磁盘插件，二次 refresh 未变时命中缓存（引用共享）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-cache-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX body");
    const runtime = makeRuntime(projectRoot, pilotHome);

    const first = await runtime.refreshWithReport();
    assert.equal(first.next.length, 1, "首次加载发现插件");
    assert.match(skillContent(runtime, "docx") ?? "", /# DOCX body/);

    const second = await runtime.refreshWithReport();
    assert.equal(second.next, first.next, "缓存命中应共享同一 plugins 引用（未重建）");
    assert.deepEqual(second.added, [], "未变时 added 为空");
    assert.deepEqual(second.removed, [], "未变时 removed 为空");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("M6: SKILL.md 内容编辑（目录 mtime 不变）→ 指纹变 → 重扫可见", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-edit-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX v1");
    const runtime = makeRuntime(projectRoot, pilotHome);
    await runtime.refreshWithReport();
    assert.match(skillContent(runtime, "docx") ?? "", /# DOCX v1/);

    // 同路径覆盖写（目录 mtime 不变，SKILL.md mtime+size 变）
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX v2 - longer body");
    const second = await runtime.refreshWithReport();
    assert.deepEqual(second.added, [], "插件身份未变（name+source 相同）");
    assert.match(skillContent(runtime, "docx") ?? "", /# DOCX v2/, "编辑后新内容立即可见");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("M6: 插件目录增删 → 指纹变 → 重扫", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-add-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX");
    const runtime = makeRuntime(projectRoot, pilotHome);
    await runtime.refreshWithReport();
    assert.equal(runtime.snapshot().length, 1);

    await writeSkill(projectRoot, "analyzer", "Analyze patents.", "# Analyzer");
    const second = await runtime.refreshWithReport();
    assert.equal(second.added.length, 1, "新增插件被发现");
    assert.equal(runtime.snapshot().length, 2);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
