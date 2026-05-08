import test from "node:test";
import assert from "node:assert/strict";
import { PluginRuntimeExtensionResolver } from "../../src/context/extension/PluginRuntimeExtensionResolver.js";
import type { PolitDeckLoadedPlugin } from "../../src/extension/index.js";

const loadedPlugin: PolitDeckLoadedPlugin = {
  name: "review",
  path: "/plugins/review",
  source: "global",
  manifest: { name: "review" },
  commands: [
    {
      name: "review:check",
      path: "/plugins/review/commands/check.md",
      content: "Check the diff",
      frontmatter: { description: "Run a code review checklist", "argument-hint": "<file>" },
      isSkill: false,
    },
  ],
  skills: [
    {
      name: "review:focus",
      path: "/plugins/review/skills/focus/skill.md",
      content: "...",
      frontmatter: { description: "Focus the review on critical paths" },
      isSkill: true,
    },
  ],
};

test("PluginRuntimeExtensionResolver flatMaps commands when no aggregator is available", () => {
  const resolver = new PluginRuntimeExtensionResolver({ snapshot: () => [loadedPlugin] });
  const commands = resolver.listCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.name, "review:check");
  assert.equal(commands[0]?.description, "Run a code review checklist");
  assert.equal(commands[0]?.argumentHint, "<file>");
  assert.equal(commands[0]?.namespace, "review");
});

test("PluginRuntimeExtensionResolver flatMaps skills when no aggregator is available", () => {
  const resolver = new PluginRuntimeExtensionResolver({ snapshot: () => [loadedPlugin] });
  const skills = resolver.listSkills();
  assert.equal(skills.length, 1);
  assert.equal(skills[0]?.name, "review:focus");
  assert.equal(skills[0]?.description, "Focus the review on critical paths");
});

test("PluginRuntimeExtensionResolver prefers getAllCommands aggregator when present", () => {
  const aggregated = [{ name: "alpha", description: "from aggregator" }];
  const resolver = new PluginRuntimeExtensionResolver({
    snapshot: () => [loadedPlugin],
    getAllCommands: () => aggregated,
  });
  assert.deepEqual(resolver.listCommands(), aggregated);
});

test("PluginRuntimeExtensionResolver returns empty MCP instructions when runtime has none", () => {
  const resolver = new PluginRuntimeExtensionResolver({ snapshot: () => [loadedPlugin] });
  assert.deepEqual(resolver.listMcpInstructions(), []);
});
