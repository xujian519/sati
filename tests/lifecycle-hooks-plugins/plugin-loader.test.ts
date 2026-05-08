import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getPluginCommandName,
  loadPluginFromPath,
  loadPluginHooks,
  PluginRuntime,
  validateMarketplaceName,
} from "../../src/extension/index.js";

test("plugin loader reads manifest and hook config from a project plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-plugin-"));
  try {
    const pluginPath = path.join(root, ".politdeck", "plugins", "demo");
    await mkdir(path.join(pluginPath, "hooks"), { recursive: true });
    await writeFile(
      path.join(pluginPath, "plugin.json"),
      JSON.stringify({ name: "demo", hooks: "hooks/hooks.json" }),
      "utf8",
    );
    await writeFile(
      path.join(pluginPath, "hooks", "hooks.json"),
      JSON.stringify({ SessionStart: [{ hooks: [{ type: "command", command: "echo ok" }] }] }),
      "utf8",
    );

    const plugin = await loadPluginFromPath(pluginPath, "project");
    const hooks = loadPluginHooks([plugin]);

    assert.equal(plugin.name, "demo");
    assert.equal(hooks.SessionStart?.[0]?.pluginName, "demo");
    assert.equal(hooks.SessionStart?.[0]?.pluginRoot, pluginPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PluginRuntime discovers only fixed global and project plugin directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-runtime-"));
  try {
    const politHome = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const globalPlugin = path.join(politHome, "plugins", "global-demo");
    const projectPlugin = path.join(projectRoot, ".politdeck", "plugins", "project-demo");
    await mkdir(globalPlugin, { recursive: true });
    await mkdir(projectPlugin, { recursive: true });
    await writeFile(path.join(globalPlugin, "plugin.json"), JSON.stringify({ name: "global-demo" }), "utf8");
    await writeFile(path.join(projectPlugin, "plugin.json"), JSON.stringify({ name: "project-demo" }), "utf8");

    const runtime = new PluginRuntime({ projectRoot, politHome });
    const plugins = await runtime.refresh();

    assert.deepEqual(plugins.map((plugin) => `${plugin.name}:${plugin.source}`).sort(), [
      "global-demo:global",
      "project-demo:project",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin command names match markdown and SKILL.md naming rules", () => {
  assert.equal(getPluginCommandName("demo", "/plugins/demo/commands/deploy.md", "/plugins/demo/commands"), "demo:deploy");
  assert.equal(
    getPluginCommandName("demo", "/plugins/demo/skills/reviewer/SKILL.md", "/plugins/demo/skills"),
    "demo:reviewer",
  );
});

test("marketplace validation blocks PolitDeck impersonation and unsafe names", () => {
  assert.equal(validateMarketplaceName("community"), undefined);
  assert.ok(validateMarketplaceName("politdeck-marketplace-new"));
  assert.ok(validateMarketplaceName("inline"));
  assert.ok(validateMarketplaceName("../bad"));
});
