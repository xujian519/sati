import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SkillManager, SkillPreferenceStore } from "../../../src/extension/skills/index.js";

async function writeSkill(root: string, slug: string, description: string): Promise<void> {
  const dir = join(root, slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${slug}\ndescription: ${description}\n---\n\n# ${slug}\n`, "utf8");
}

test("缺省启用；user 关闭后对所有作用域生效", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-prefs-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const builtinSkillsRoot = join(root, "bundled");
    await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");
    await writeSkill(join(pilotHome, "skills"), "custom", "User custom");

    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
    const before = await manager.list({ projectKey: projectRoot });
    assert.equal(before.user.find(skill => skill.slug === "custom")?.enabled, true);

    manager.setEnabled({ scope: "user", slug: "pdf", enabled: false });
    const after = await manager.list({ projectKey: projectRoot });
    assert.equal(after.builtin.find(skill => skill.slug === "pdf")?.enabled, false);

    const enabledOnly = await manager.list({ projectKey: projectRoot, enabledOnly: true });
    assert.equal(
      enabledOnly.builtin.some(skill => skill.slug === "pdf"),
      false,
    );
    assert.equal(
      enabledOnly.user.some(skill => skill.slug === "custom"),
      true,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project 覆盖优先于 user 与 builtin", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-prefs-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const projectRoot = join(root, "project");
    const builtinSkillsRoot = join(root, "bundled");
    await writeSkill(builtinSkillsRoot, "pdf", "Built-in PDF");

    const manager = new SkillManager({ pilotHome, builtinSkillsRoot });
    manager.setEnabled({ scope: "builtin", slug: "pdf", enabled: false });
    manager.setEnabled({ scope: "user", slug: "pdf", enabled: false });
    manager.setEnabled({ scope: "project", slug: "pdf", projectKey: projectRoot, enabled: true });

    const result = await manager.list({ projectKey: projectRoot });
    assert.equal(result.builtin.find(skill => skill.slug === "pdf")?.enabled, true);

    const otherProject = await manager.list({ projectKey: join(root, "other-project") });
    assert.equal(otherProject.builtin.find(skill => skill.slug === "pdf")?.enabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("坏偏好文件 fail-open（全部启用）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-prefs-"));
  try {
    const pilotHome = join(root, "pilot-home");
    await mkdir(pilotHome, { recursive: true });
    await writeFile(join(pilotHome, "skill-preferences.json"), "{not-json", "utf8");

    const store = new SkillPreferenceStore(pilotHome);
    assert.equal(store.isEnabled("pdf"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("偏好文件权限 0600 且可被新实例读回", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-skill-prefs-"));
  try {
    const pilotHome = join(root, "pilot-home");
    const store = new SkillPreferenceStore(pilotHome);
    store.setEnabled({ scope: "user", slug: "pdf", enabled: false });

    const mode = (await stat(join(pilotHome, "skill-preferences.json"))).mode & 0o777;
    assert.equal(mode, 0o600);

    const reloaded = new SkillPreferenceStore(pilotHome);
    assert.equal(reloaded.isEnabled("pdf"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project 作用域缺少 projectKey 时拒绝写入", () => {
  const store = new SkillPreferenceStore("/tmp/sati-skill-prefs-unused");
  assert.throws(() => store.setEnabled({ scope: "project", slug: "pdf", enabled: false }), /requires projectKey/);
});
