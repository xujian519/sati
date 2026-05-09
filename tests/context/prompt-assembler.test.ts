import test from "node:test";
import assert from "node:assert/strict";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import { NullExtensionResolver, type ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";

const baseInput = {
  cwd: "/tmp/proj",
  provider: "edgeclaw",
  model: "moonshotai/kimi-k2.6",
  permissionMode: "default",
  additionalWorkingDirectories: [],
  tools: [
    { name: "read_file", description: "Read a file from the workspace.", inputSchema: { type: "object" } },
    { name: "bash", description: "Run a shell command.", inputSchema: { type: "object" } },
  ],
  now: () => new Date("2026-05-01T12:00:00.000Z"),
};

test("PromptAssembler default flow contains identity, tools, permission mode, and user context", () => {
  const assembler = new PromptAssembler(new NullExtensionResolver());
  const result = assembler.assemble(baseInput);
  const joined = result.joined;
  assert.match(joined, /You are PolitDeck/);
  assert.match(joined, /Available tools:/);
  assert.match(joined, /- read_file: Read a file/);
  assert.match(joined, /- bash: Run a shell command/);
  assert.match(joined, /Permission mode: default/);
  assert.match(joined, /<user-context>/);
  assert.match(joined, /cwd: \/tmp\/proj/);
  assert.match(joined, /model: edgeclaw\/moonshotai\/kimi-k2\.6/);
  assert.match(joined, /<environment>/);
  assert.match(joined, /now: 2026-05-01T12:00:00\.000Z/);
});

test("PromptAssembler custom system prompt replaces default and system context but keeps user context and append", () => {
  const assembler = new PromptAssembler(new NullExtensionResolver());
  const result = assembler.assemble({
    ...baseInput,
    customSystemPrompt: "You are a strict reviewer.",
    appendSystemPrompt: "Always reply in English.",
  });
  // No default identity nor system context (env / commands)
  assert.doesNotMatch(result.joined, /You are PolitDeck/);
  assert.doesNotMatch(result.joined, /<environment>/);
  // Custom prompt is at top
  assert.match(result.parts[0]!, /strict reviewer/);
  // User context kept
  assert.match(result.joined, /<user-context>/);
  // Append prompt last
  assert.match(result.parts.at(-1)!, /Always reply in English/);
});

test("PromptAssembler renders extension commands and skills", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [
      { name: "review", description: "Review a PR" },
      { name: "deploy", description: "Deploy to staging", argumentHint: "<env>" },
    ],
    listSkills: () => [{ name: "code-review", description: "Structured code review playbook" }],
    listMcpInstructions: () => [],
  };
  const assembler = new PromptAssembler(extension);
  const result = assembler.assemble(baseInput);
  assert.match(result.joined, /<available-commands>/);
  assert.match(result.joined, /- \/review — Review a PR/);
  assert.match(result.joined, /- \/deploy <env> — Deploy to staging/);
  assert.match(result.joined, /<available-skills>/);
  assert.match(result.joined, /- code-review — Structured code review playbook/);
});

test("PromptAssembler renders MCP instructions in <mcp-instructions> block when ExtensionResolver provides them", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [],
    listMcpInstructions: () => [{ serverName: "filesystem", instructions: "Use only project paths." }],
  };
  const assembler = new PromptAssembler(extension);
  const result = assembler.assemble(baseInput);
  assert.match(result.joined, /Connected MCP server instructions:/);
  assert.match(result.joined, /<mcp-instructions>/);
  assert.match(result.joined, /<server name="filesystem">/);
  assert.match(result.joined, /Use only project paths\./);
  assert.match(result.joined, /<\/server>/);
  assert.match(result.joined, /<\/mcp-instructions>/);
});

test("B3 PromptAssembler sorts MCP servers by name and skips empty instructions", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [],
    listMcpInstructions: () => [
      { serverName: "zeta", instructions: "z body" },
      { serverName: "empty" }, // no instructions → dropped
      { serverName: "alpha", instructions: "a body" },
    ],
  };
  const assembler = new PromptAssembler(extension);
  const result = assembler.assemble(baseInput);
  assert.match(result.joined, /<mcp-instructions>/);
  const alphaIdx = result.joined.indexOf('<server name="alpha">');
  const zetaIdx = result.joined.indexOf('<server name="zeta">');
  assert.ok(alphaIdx > 0 && zetaIdx > 0, "both populated entries appear");
  assert.ok(alphaIdx < zetaIdx, "alpha sorts before zeta");
  assert.doesNotMatch(result.joined, /<server name="empty">/);
});

test("B3 PromptAssembler omits the entire MCP block when no server contributes", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [],
    listMcpInstructions: () => [],
  };
  const assembler = new PromptAssembler(extension);
  const result = assembler.assemble(baseInput);
  assert.doesNotMatch(result.joined, /Connected MCP server instructions:/);
  assert.doesNotMatch(result.joined, /<mcp-instructions>/);
});

test("PromptAssembler reflects plan permission mode and additional working directories", () => {
  const assembler = new PromptAssembler(new NullExtensionResolver());
  const result = assembler.assemble({
    ...baseInput,
    permissionMode: "plan",
    additionalWorkingDirectories: ["/tmp/extra-1", "/tmp/extra-2"],
  });
  assert.match(result.joined, /Permission mode: plan/);
  assert.match(result.joined, /Additional working directories you may operate in:/);
  assert.match(result.joined, /- \/tmp\/extra-1/);
  assert.match(result.joined, /- \/tmp\/extra-2/);
});
