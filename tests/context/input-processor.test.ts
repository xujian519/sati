import test from "node:test";
import assert from "node:assert/strict";
import { InputProcessor } from "../../src/context/input/InputProcessor.js";
import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";

test("InputProcessor passes plain text through unchanged", () => {
  const processor = new InputProcessor();
  const result = processor.process({ type: "text", text: "Hello world" });
  assert.equal(result.shouldCallModel, true);
  assert.equal(result.messages.length, 1);
  assert.equal((result.messages[0]?.content[0] as { text: string }).text, "Hello world");
  assert.equal(result.command, undefined);
  assert.equal(result.diagnostics.length, 0);
});

test("InputProcessor flags unknown slash command but still forwards as text", () => {
  const processor = new InputProcessor();
  const result = processor.process({ type: "text", text: "/nope arg1" });
  assert.equal(result.shouldCallModel, true);
  assert.equal(result.command?.source, "unknown");
  assert.equal(result.command?.name, "nope");
  assert.equal(result.diagnostics.some((d) => d.code === "unknown_command"), true);
  assert.equal((result.messages[0]?.content[0] as { text: string }).text, "/nope arg1");
});

test("InputProcessor recognises plugin command via ExtensionResolver", () => {
  const extension: ExtensionResolver = {
    listCommands: () => [{ name: "review", description: "Run code review" }],
    listSkills: () => [],
    listMcpInstructions: () => [],
  };
  const processor = new InputProcessor({ extension });
  const result = processor.process({ type: "text", text: "/review src/foo.ts" });
  assert.equal(result.command?.source, "extension");
  assert.equal(result.command?.argument, "src/foo.ts");
  assert.match((result.messages[0]?.content[0] as { text: string }).text, /Run plugin command "\/review"/);
});

test("InputProcessor isMeta=true does not request a model call", () => {
  const processor = new InputProcessor();
  const result = processor.process({ type: "text", text: "internal", isMeta: true });
  assert.equal(result.shouldCallModel, false);
});

test("InputProcessor passes through canonical block input", () => {
  const processor = new InputProcessor();
  const result = processor.process({
    type: "blocks",
    content: [{ type: "text", text: "from blocks" }],
  });
  assert.equal(result.messages[0]?.content[0]?.type, "text");
  assert.equal(result.shouldCallModel, true);
});
