import test from "node:test";
import assert from "node:assert/strict";
import { parsePluginManifest } from "../../../src/extension/plugins/config/parsePluginManifest.js";
import { validateMarketplaceName } from "../../../src/extension/plugins/config/validateMarketplaceName.js";
import { validatePluginSourcePath } from "../../../src/extension/plugins/config/validatePluginSource.js";
import { resolveMarketplaceReference } from "../../../src/extension/plugins/protocol/marketplace.js";
import {
  MAX_MCP_INSTRUCTION_LENGTH,
  truncateMcpInstructionString,
} from "../../../src/extension/plugins/runtime/truncateMcpString.js";

test("parsePluginManifest throws on non-object and missing name", () => {
  assert.throws(() => parsePluginManifest(null), /must be an object/);
  assert.throws(() => parsePluginManifest("x"), /must be an object/);
  assert.throws(() => parsePluginManifest([]), /must be an object/);
  assert.throws(() => parsePluginManifest({}), /must contain a name/);
  assert.throws(() => parsePluginManifest({ name: "  " }), /must contain a name/);
});

test("parsePluginManifest parses a full manifest", () => {
  const manifest = parsePluginManifest({
    name: "my-plugin",
    version: "1.2.3",
    description: "desc",
    commands: ["cmd1", "cmd2"],
    agents: "single-agent",
    skills: ["skill-a"],
    hooks: { PreToolUse: [] },
    mcpServers: { server: { command: "npx" } },
    lspServers: { py: { command: "pylsp" } },
    outputStyles: "style-x",
    marketplace: {
      name: "example",
      plugin: "my-plugin",
      version: "0.1.0",
      source: "marketplace",
      url: "https://example.com",
    },
    mcpb: "bundle.mcpb",
    settings: { enabled: true },
  });
  assert.equal(manifest.name, "my-plugin");
  assert.equal(manifest.version, "1.2.3");
  assert.deepEqual(manifest.commands, ["cmd1", "cmd2"]);
  assert.equal(manifest.agents, "single-agent");
  assert.deepEqual(manifest.skills, ["skill-a"]);
  assert.deepEqual(manifest.hooks, { PreToolUse: [] });
  assert.deepEqual(manifest.mcpServers, { server: { command: "npx" } });
  assert.deepEqual(manifest.marketplace, {
    name: "example",
    plugin: "my-plugin",
    version: "0.1.0",
    source: "marketplace",
    url: "https://example.com",
  });
  assert.equal(manifest.mcpb, "bundle.mcpb");
  assert.deepEqual(manifest.settings, { enabled: true });
});

test("parsePluginManifest tolerates malformed optional fields", () => {
  const manifest = parsePluginManifest({
    name: "p",
    version: 42,
    commands: [1, 2],
    agents: { bad: true },
    skills: "ok",
    hooks: "hooks-dir",
    mcpServers: "not-a-record",
    lspServers: null,
    outputStyles: 7,
    marketplace: { name: "x" }, // missing plugin -> dropped
    mcpb: "no-extension",
    settings: "nope",
  });
  assert.equal(manifest.version, undefined);
  assert.equal(manifest.commands, undefined);
  assert.equal(manifest.agents, undefined);
  assert.equal(manifest.skills, "ok");
  assert.equal(manifest.hooks, "hooks-dir");
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.lspServers, undefined);
  assert.equal(manifest.outputStyles, undefined);
  assert.equal(manifest.marketplace, undefined);
  assert.equal(manifest.mcpb, undefined);
  assert.equal(manifest.settings, undefined);
});

test("parsePluginManifest accepts mcpb with .dxt suffix only", () => {
  assert.equal(parsePluginManifest({ name: "p", mcpb: "b.dxt" }).mcpb, "b.dxt");
  assert.equal(parsePluginManifest({ name: "p", mcpb: "b.zip" }).mcpb, undefined);
  assert.equal(parsePluginManifest({ name: "p", mcpb: 5 }).mcpb, undefined);
});

test("parsePluginManifest parses marketplace source variants", () => {
  for (const source of ["marketplace", "git", "zip", "mcpb"]) {
    const manifest = parsePluginManifest({
      name: "p",
      marketplace: { name: "m", plugin: "p", source },
    });
    assert.equal(manifest.marketplace?.source, source);
  }
  const bad = parsePluginManifest({ name: "p", marketplace: { name: "m", plugin: "p", source: "ftp" } });
  assert.equal(bad.marketplace?.source, undefined);
});

test("validateMarketplaceName rejects invalid names", () => {
  assert.ok(validateMarketplaceName("") !== undefined);
  assert.ok(validateMarketplaceName("has space") !== undefined);
  assert.ok(validateMarketplaceName("a/b") !== undefined);
  assert.ok(validateMarketplaceName("a\\b") !== undefined);
  assert.ok(validateMarketplaceName("..") !== undefined);
  assert.ok(validateMarketplaceName(".") !== undefined);
  assert.ok(validateMarketplaceName("inline") !== undefined);
  assert.ok(validateMarketplaceName("BUILTIN") !== undefined);
  assert.ok(validateMarketplaceName("official-sati") !== undefined);
  assert.ok(validateMarketplaceName("sati官方") !== undefined);
});

test("validateMarketplaceName accepts plain names", () => {
  assert.equal(validateMarketplaceName("my-market"), undefined);
  assert.equal(validateMarketplaceName("example-2026"), undefined);
});

test("validatePluginSourcePath allows root and descendants only", () => {
  const root = "/data/plugins";
  assert.equal(validatePluginSourcePath("/data/plugins", root), true);
  assert.equal(validatePluginSourcePath("/data/plugins/a/b", root), true);
  assert.equal(validatePluginSourcePath("/data/plugins-other/x", root), false);
  assert.equal(validatePluginSourcePath("/data", root), false);
  assert.equal(validatePluginSourcePath("/etc/passwd", root), false);
});

test("resolveMarketplaceReference defers git/zip/mcpb and resolves marketplace", () => {
  const resolved = resolveMarketplaceReference({ name: "m", plugin: "p", source: "marketplace" });
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.reason, undefined);

  for (const source of ["git", "zip", "mcpb"] as const) {
    const deferred = resolveMarketplaceReference({ name: "m", plugin: "p", source });
    assert.equal(deferred.status, "deferred");
    assert.match(deferred.reason ?? "", new RegExp(source));
  }
});

test("truncateMcpInstructionString caps at 2048 with marker", () => {
  const short = "a".repeat(2048);
  assert.equal(truncateMcpInstructionString(short), short);
  const long = "a".repeat(3000);
  const out = truncateMcpInstructionString(long);
  assert.equal(out.length, MAX_MCP_INSTRUCTION_LENGTH + "… [truncated]".length);
  assert.ok(out.endsWith("… [truncated]"));
  assert.equal(out.slice(0, 2048), long.slice(0, 2048));
});
