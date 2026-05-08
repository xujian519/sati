import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAttachmentBuilder } from "../../src/context/memory/MemoryAttachmentBuilder.js";

test("MemoryAttachmentBuilder produces a single attachment with retrieved systemContext", async () => {
  const builder = new MemoryAttachmentBuilder({
    retrieve: async () => ({ systemContext: "User prefers concise answers.", diagnostics: [] }),
    captureTurn: async () => undefined,
  });
  const result = await builder.build({
    query: "summary",
    sessionId: "s",
    projectRoot: "/tmp/proj",
    recentMessages: [],
  });
  assert.equal(result.attachments.length, 1);
  const block = result.attachments[0]?.content[0] as { text: string };
  assert.match(block.text, /<memory-context>/);
  assert.match(block.text, /User prefers concise answers/);
});

test("MemoryAttachmentBuilder skips when retrieve returns empty systemContext", async () => {
  const builder = new MemoryAttachmentBuilder({
    retrieve: async () => ({ systemContext: "", diagnostics: [] }),
    captureTurn: async () => undefined,
  });
  const result = await builder.build({
    query: "",
    sessionId: "s",
    projectRoot: "/tmp",
    recentMessages: [],
  });
  assert.equal(result.attachments.length, 0);
});

test("MemoryAttachmentBuilder reports retrieve failures as diagnostic, not throw", async () => {
  const builder = new MemoryAttachmentBuilder({
    retrieve: async () => {
      throw new Error("memory backend offline");
    },
    captureTurn: async () => undefined,
  });
  const result = await builder.build({
    query: "summary",
    sessionId: "s",
    projectRoot: "/tmp",
    recentMessages: [],
  });
  assert.equal(result.attachments.length, 0);
  assert.equal(result.diagnostics[0]?.code, "memory_provider_error");
  assert.match(result.diagnostics[0]!.message, /memory backend offline/);
});
