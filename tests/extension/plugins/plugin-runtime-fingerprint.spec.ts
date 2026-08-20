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

test("M6 #8a: 嵌套 commands 文件内容编辑（目录 mtime 不变）→ 递归指纹 → 重扫可见", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-nested-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    const pluginDir = join(projectRoot, ".sati", "plugins", "deep");
    await mkdir(join(pluginDir, "commands", "sub"), { recursive: true });
    await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "deep", version: "0.0.1" }), "utf8");
    await writeFile(join(pluginDir, "commands", "sub", "task.md"), "---\nname: task\n---\n\n# Task v1\n", "utf8");
    const runtime = makeRuntime(projectRoot, pilotHome);
    const first = await runtime.refreshWithReport();
    const content = () => runtime.snapshot().find(p => p.name === "deep")?.commands?.[0]?.content;
    assert.match(content() ?? "", /# Task v1/);

    // 覆盖写嵌套文件：目录 mtime 不变（文件内容更新不触目录 mtime）——旧指纹
    // 只 stat 根部条目会漏检并命中缓存（编辑被 TTL 延迟 10s）。
    await writeFile(
      join(pluginDir, "commands", "sub", "task.md"),
      "---\nname: task\n---\n\n# Task v2 - nested edit\n",
      "utf8",
    );
    const second = await runtime.refreshWithReport();
    assert.notEqual(second.next, first.next, "指纹变化应触发重扫（非缓存命中共享引用）");
    assert.match(content() ?? "", /# Task v2/, "嵌套文件编辑后新内容立即可见");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("M6 #8c: 部分加载失败不写指纹缓存，修复后立即可见", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-fail-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    const brokenDir = join(projectRoot, ".sati", "plugins", "broken");
    await mkdir(brokenDir, { recursive: true }); // 无 plugin.json → 加载失败
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX");
    const runtime = makeRuntime(projectRoot, pilotHome);

    await runtime.refreshWithReport();
    assert.equal(runtime.snapshot().length, 1, "好插件加载，坏插件被过滤");
    const cacheOf = (r: PluginRuntime) => (r as unknown as { fingerprintCache: unknown }).fingerprintCache;
    assert.equal(cacheOf(runtime), null, "存在加载失败时不得写指纹缓存（失败不被固化）");

    // 修复坏插件：写合法 plugin.json
    await writeFile(join(brokenDir, "plugin.json"), JSON.stringify({ name: "broken", version: "0.0.1" }), "utf8");
    await runtime.refreshWithReport();
    assert.ok(
      runtime.snapshot().some(p => p.name === "broken"),
      "修复后坏插件出现",
    );
    assert.notEqual(cacheOf(runtime), null, "全部加载成功后写缓存");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("M6 #8d: 缓存命中时按实际 registry 状态计算 diff（外部改动不被吞掉）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-m6-diff-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-m6-home-"));
  try {
    await writeSkill(projectRoot, "docx", "Create Word documents.", "# DOCX");
    const runtime = makeRuntime(projectRoot, pilotHome);
    await runtime.refreshWithReport(); // 建立指纹缓存

    // 模拟外部改动清空 registry（命中路径 replaceAll 前 previous 与实际不同）
    const registry = (runtime as unknown as { registry: { replaceAll(plugins: unknown[]): void } }).registry;
    registry.replaceAll([]);

    const second = await runtime.refreshWithReport(); // 指纹未变且 TTL 内 → 命中
    assert.equal(second.next.length, 1, "命中恢复缓存内容");
    assert.deepEqual(
      second.added.map(p => p.name),
      ["docx"],
      "命中时 added 应反映恢复的差异（不得恒为空数组）",
    );
    assert.deepEqual(second.removed, [], "previous 为空则 removed 为空");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
