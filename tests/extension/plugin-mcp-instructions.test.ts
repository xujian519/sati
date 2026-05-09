import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MCP_INSTRUCTION_LENGTH,
  PluginRuntime,
  truncateMcpInstructionString,
} from "../../src/extension/index.js";
import type { PolitDeckLoadedPlugin } from "../../src/extension/index.js";

function makePlugin(name: string, mcpServers?: Record<string, unknown>): PolitDeckLoadedPlugin {
  return {
    name,
    path: `/plugins/${name}`,
    source: "global",
    manifest: { name },
    mcpServers,
  };
}

function newRuntime(plugins: PolitDeckLoadedPlugin[]): PluginRuntime {
  const runtime = new PluginRuntime({
    projectRoot: "/tmp/project",
    politHome: "/tmp/polit",
    builtinPlugins: plugins,
    builtinPluginsEnabled: Object.fromEntries(plugins.map((p) => [p.name, true])),
  });
  return runtime;
}

test("B3.W1 truncateMcpInstructionString caps at MAX_MCP_INSTRUCTION_LENGTH and appends sentinel", () => {
  const short = "abc";
  assert.equal(truncateMcpInstructionString(short), short);
  const long = "x".repeat(MAX_MCP_INSTRUCTION_LENGTH + 100);
  const out = truncateMcpInstructionString(long);
  assert.ok(out.length <= MAX_MCP_INSTRUCTION_LENGTH + 30);
  assert.match(out, /… \[truncated\]$/);
});

test("B3.W2 PluginRuntime.getAllMcpInstructions returns [] when no plugin contributes", () => {
  const runtime = newRuntime([makePlugin("a")]);
  return runtime.refresh().then(() => {
    assert.deepEqual(runtime.getAllMcpInstructions(), []);
  });
});

test("B3.W3 PluginRuntime.getAllMcpInstructions reads instructions from manifest", async () => {
  const runtime = newRuntime([
    makePlugin("alpha", {
      figma: { instructions: "Use the Figma MCP for design exports." },
    }),
  ]);
  await runtime.refresh();
  const out = runtime.getAllMcpInstructions();
  assert.equal(out.length, 1);
  assert.equal(out[0]?.serverName, "figma");
  assert.equal(out[0]?.instructions, "Use the Figma MCP for design exports.");
});

test("B3.W4 PluginRuntime.getAllMcpInstructions truncates long instructions with sentinel", async () => {
  const long = "y".repeat(MAX_MCP_INSTRUCTION_LENGTH + 200);
  const runtime = newRuntime([
    makePlugin("alpha", {
      bigserver: { instructions: long },
    }),
  ]);
  await runtime.refresh();
  const out = runtime.getAllMcpInstructions();
  assert.equal(out.length, 1);
  assert.match(out[0]!.instructions, /… \[truncated\]$/);
  assert.ok(out[0]!.instructions.length < long.length);
});

test("B3.W5 PluginRuntime.getAllMcpInstructions sorts servers by name (cache stability)", async () => {
  const runtime = newRuntime([
    makePlugin("alpha", {
      zeta: { instructions: "z" },
      alpha: { instructions: "a" },
      mid: { instructions: "m" },
    }),
  ]);
  await runtime.refresh();
  const out = runtime.getAllMcpInstructions();
  assert.deepEqual(
    out.map((e) => e.serverName),
    ["alpha", "mid", "zeta"],
  );
});

test("B3.W6 PluginRuntime.getAllMcpInstructions skips entries with empty / non-string instructions", async () => {
  const runtime = newRuntime([
    makePlugin("alpha", {
      empty: { instructions: "" },
      whitespace: { instructions: "   \n\t  " },
      missing: {},
      wrong_type: { instructions: 123 },
      ok: { instructions: "do the thing" },
    }),
  ]);
  await runtime.refresh();
  const out = runtime.getAllMcpInstructions();
  assert.deepEqual(
    out.map((e) => e.serverName),
    ["ok"],
  );
});

test("B3.W7 PluginRuntime.getAllMcpInstructions: first plugin wins on duplicate serverName", async () => {
  const runtime = newRuntime([
    makePlugin("first", { same: { instructions: "FROM_FIRST" } }),
    makePlugin("second", { same: { instructions: "FROM_SECOND" } }),
  ]);
  await runtime.refresh();
  const out = runtime.getAllMcpInstructions();
  assert.equal(out.length, 1);
  assert.equal(out[0]?.instructions, "FROM_FIRST");
});
