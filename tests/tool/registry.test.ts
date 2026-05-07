import test from "node:test";
import assert from "node:assert/strict";
import { ToolRegistry } from "../../src/tool/index.js";
import { createPolitDeckTestTool } from "../helpers/tool.js";

test("registers tools and resolves aliases", () => {
  const registry = new ToolRegistry();
  registry.register(createPolitDeckTestTool({ name: "read_file", aliases: ["Read"] }));

  assert.equal(registry.has("read_file"), true);
  assert.equal(registry.get("Read")?.name, "read_file");
});

test("rejects duplicate tool names and alias conflicts", () => {
  const registry = new ToolRegistry();
  registry.register(createPolitDeckTestTool({ name: "read_file", aliases: ["Read"] }));

  assert.throws(() => registry.register(createPolitDeckTestTool({ name: "read_file" })));
  assert.throws(() => registry.register(createPolitDeckTestTool({ name: "Read" })));
  assert.throws(() => registry.register(createPolitDeckTestTool({ name: "grep", aliases: ["Read"] })));
});

test("returns stable sorted canonical schemas", () => {
  const registry = new ToolRegistry();
  registry.register(createPolitDeckTestTool({ name: "write_file" }));
  registry.register(createPolitDeckTestTool({ name: "read_file" }));

  assert.deepEqual(
    registry.toCanonicalSchemas().map((schema) => schema.name),
    ["read_file", "write_file"],
  );
});
