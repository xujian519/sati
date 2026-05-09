import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getPluginCommandName,
  loadPluginCommands,
  loadPluginFromPath,
  loadPluginHooks,
  PluginRuntime,
  resolveMarketplaceReference,
  validateMarketplaceName,
} from "../../src/extension/index.js";

test("plugin loader reads manifest and hook config from a project plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-plugin-"));
  try {
    const pluginPath = path.join(root, ".pilotdeck", "plugins", "demo");
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
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-runtime-"));
  try {
    const pilotHome = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const globalPlugin = path.join(pilotHome, "plugins", "global-demo");
    const projectPlugin = path.join(projectRoot, ".pilotdeck", "plugins", "project-demo");
    await mkdir(globalPlugin, { recursive: true });
    await mkdir(projectPlugin, { recursive: true });
    await writeFile(path.join(globalPlugin, "plugin.json"), JSON.stringify({ name: "global-demo" }), "utf8");
    await writeFile(path.join(projectPlugin, "plugin.json"), JSON.stringify({ name: "project-demo" }), "utf8");

    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    const plugins = await runtime.refresh();

    assert.deepEqual(plugins.map((plugin) => `${plugin.name}:${plugin.source}`).sort(), [
      "global-demo:global",
      "project-demo:project",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PluginRuntime refresh report atomically removes deleted plugins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-prune-"));
  try {
    const pilotHome = path.join(root, "home");
    const projectRoot = path.join(root, "project");
    const pluginPath = path.join(projectRoot, ".pilotdeck", "plugins", "project-demo");
    await mkdir(pluginPath, { recursive: true });
    await writeFile(path.join(pluginPath, "plugin.json"), JSON.stringify({ name: "project-demo" }), "utf8");

    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    assert.equal((await runtime.refreshWithReport()).next.length, 1);

    await rm(pluginPath, { recursive: true, force: true });
    const report = await runtime.refreshWithReport();

    assert.deepEqual(report.previous.map((plugin) => plugin.name), ["project-demo"]);
    assert.deepEqual(report.next, []);
    assert.deepEqual(report.removed.map((plugin) => plugin.name), ["project-demo"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PluginRuntime filters disabled builtin plugins", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-builtin-"));
  try {
    const runtime = new PluginRuntime({
      projectRoot: path.join(root, "project"),
      pilotHome: path.join(root, "home"),
      builtinPlugins: [
        {
          name: "enabled",
          path: "<builtin>",
          source: "builtin",
          manifest: { name: "enabled" },
        },
        {
          name: "disabled",
          path: "<builtin>",
          source: "builtin",
          manifest: { name: "disabled" },
        },
      ],
      builtinPluginsEnabled: { disabled: false },
    });

    assert.deepEqual((await runtime.refresh()).map((plugin) => plugin.name), ["enabled"]);
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

test("plugin command loader reads markdown content and frontmatter", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-commands-"));
  try {
    const commandsDir = path.join(root, "commands");
    await mkdir(path.join(commandsDir, "db"), { recursive: true });
    await writeFile(
      path.join(commandsDir, "db", "migrate.md"),
      "---\ndescription: Run migration\nallowed: true\n---\nRun migration",
      "utf8",
    );

    const commands = await loadPluginCommands({ pluginName: "demo", baseDir: commandsDir });

    assert.equal(commands[0]?.name, "demo:db:migrate");
    assert.equal(commands[0]?.content, "Run migration");
    assert.deepEqual(commands[0]?.frontmatter, { description: "Run migration", allowed: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plugin loader includes command, skill and MCP contributions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-contrib-"));
  try {
    const pluginPath = path.join(root, "demo");
    await mkdir(path.join(pluginPath, "commands"), { recursive: true });
    await mkdir(path.join(pluginPath, "skills", "reviewer"), { recursive: true });
    await writeFile(
      path.join(pluginPath, "plugin.json"),
      JSON.stringify({ name: "demo", mcpServers: { local: { command: "server" } } }),
      "utf8",
    );
    await writeFile(path.join(pluginPath, "commands", "deploy.md"), "Deploy", "utf8");
    await writeFile(path.join(pluginPath, "skills", "reviewer", "SKILL.md"), "Review", "utf8");

    const plugin = await loadPluginFromPath(pluginPath, "project");

    assert.deepEqual(plugin.commands?.map((command) => command.name), ["demo:deploy"]);
    assert.deepEqual(plugin.skills?.map((skill) => skill.name), ["demo:reviewer"]);
    assert.deepEqual(plugin.mcpServers, { local: { command: "server" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PluginRuntime exposes merged MCP server contributions", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "builtin",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "builtin" },
        mcpServers: { builtinServer: { command: "builtin" } },
      },
    ],
  });

  await runtime.refresh();

  assert.deepEqual(runtime.mcpServers(), { builtinServer: { command: "builtin" } });
});

test("PluginRuntime exposes a stable contribution snapshot", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "builtin",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "builtin" },
        commands: [
          {
            name: "builtin:deploy",
            path: "<builtin>/commands/deploy.md",
            content: "Deploy",
            frontmatter: { description: "Deploy the app", "argument-hint": "<env>" },
            isSkill: false,
          },
        ],
        skills: [
          {
            name: "builtin:review",
            path: "<builtin>/skills/review/SKILL.md",
            content: "Review",
            frontmatter: { description: "Review code" },
            isSkill: true,
          },
        ],
        hooksConfig: {
          SessionStart: [{ hooks: [{ type: "command", command: "echo ok" }] }],
        },
        mcpServers: { local: { command: "server", instructions: "Use local tools." } },
      },
    ],
  });

  await runtime.refresh();
  const snapshot = runtime.snapshotContributions();

  assert.equal(snapshot.commands[0]?.name, "builtin:deploy");
  assert.equal(snapshot.commands[0]?.argumentHint, "<env>");
  assert.equal(snapshot.skills[0]?.name, "builtin:review");
  assert.equal(snapshot.hooks.SessionStart?.[0]?.pluginName, "builtin");
  assert.deepEqual(snapshot.mcpInstructions, [{ serverName: "local", instructions: "Use local tools." }]);
});

test("plugin loader includes output style and LSP contributions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pilotdeck-output-lsp-"));
  try {
    const pluginPath = path.join(root, "demo");
    await mkdir(path.join(pluginPath, "output-styles"), { recursive: true });
    await writeFile(
      path.join(pluginPath, "plugin.json"),
      JSON.stringify({ name: "demo", lspServers: { ts: { command: "typescript-language-server" } } }),
      "utf8",
    );
    await writeFile(path.join(pluginPath, "output-styles", "brief.md"), "Brief style", "utf8");

    const plugin = await loadPluginFromPath(pluginPath, "project");

    assert.deepEqual(plugin.outputStyles?.map((style) => style.name), ["demo:brief"]);
    assert.deepEqual(plugin.lspServers, { ts: { command: "typescript-language-server" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PluginRuntime exposes merged LSP server contributions", async () => {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/project",
    pilotHome: "/tmp/pilot",
    builtinPlugins: [
      {
        name: "builtin",
        path: "<builtin>",
        source: "builtin",
        manifest: { name: "builtin" },
        lspServers: { ts: { command: "ts-ls" } },
      },
    ],
  });

  await runtime.refresh();

  assert.deepEqual(runtime.lspServers(), { ts: { command: "ts-ls" } });
});

test("marketplace references resolve only local marketplace metadata and defer installers", () => {
  assert.deepEqual(resolveMarketplaceReference({ name: "community", plugin: "demo" }), {
    status: "resolved",
    reference: { name: "community", plugin: "demo" },
  });
  assert.equal(resolveMarketplaceReference({ name: "community", plugin: "demo", source: "git", url: "https://example.test/repo.git" }).status, "deferred");
  assert.equal(resolveMarketplaceReference({ name: "community", plugin: "demo", source: "zip", url: "https://example.test/plugin.zip" }).status, "deferred");
  assert.equal(resolveMarketplaceReference({ name: "community", plugin: "demo", source: "mcpb", url: "https://example.test/plugin.mcpb" }).status, "deferred");
});

test("marketplace validation blocks PilotDeck impersonation and unsafe names", () => {
  assert.equal(validateMarketplaceName("community"), undefined);
  assert.ok(validateMarketplaceName("pilotdeck-marketplace-new"));
  assert.ok(validateMarketplaceName("inline"));
  assert.ok(validateMarketplaceName("../bad"));
});
