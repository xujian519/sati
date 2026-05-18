import test from "node:test";
import assert from "node:assert/strict";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { CanonicalMessage } from "../../src/model/index.js";

const baseInput = {
  sessionId: "session-1",
  turnId: "turn-1",
  cwd: "/tmp/proj",
  provider: "edgeclaw",
  model: "moonshotai/kimi-k2.6",
  permissionMode: "default",
  additionalWorkingDirectories: [],
  messages: [
    { role: "user" as const, content: [{ type: "text" as const, text: "What changed in the codebase?" }] },
  ] as CanonicalMessage[],
  tools: [{ name: "read_file", description: "Read a file.", inputSchema: { type: "object" } }],
};

test("DefaultContextRuntime injects memory context section into systemPromptParts", async () => {
  const runtime = new DefaultContextRuntime({
    memoryResolver: {
      retrieve: async () => ({
        systemContext: "Project prefers TypeScript strict mode.",
        diagnostics: [],
      }),
      captureTurn: async () => undefined,
    },
  });
  const context = await runtime.prepareForModel(baseInput);
  assert.ok(context.systemPromptParts.length >= 4); // default + user + system + memory
  const memoryPart = context.systemPromptParts.at(-1)!;
  assert.match(memoryPart, /<memory-context>/);
  assert.match(memoryPart, /TypeScript strict mode/);
});

test("DefaultContextRuntime memory failure surfaces as diagnostic, not throw", async () => {
  const runtime = new DefaultContextRuntime({
    memoryResolver: {
      retrieve: async () => {
        throw new Error("memory offline");
      },
      captureTurn: async () => undefined,
    },
  });
  const context = await runtime.prepareForModel(baseInput);
  assert.ok(context.diagnostics.some((d) => d.code === "memory_provider_error"));
});

test("DefaultContextRuntime times out stalled memory retrieval and continues", async () => {
  const runtime = new DefaultContextRuntime({
    memoryResolver: {
      retrieve: async () => await new Promise<never>(() => undefined),
      captureTurn: async () => undefined,
    },
    memoryRetrievalTimeoutMs: 10,
  });
  const context = await runtime.prepareForModel(baseInput);
  assert.ok(context.diagnostics.some((d) =>
    d.code === "memory_provider_error" && /timed out/i.test(d.message)
  ));
});

test("DefaultContextRuntime exits memory retrieval quickly when aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  const runtime = new DefaultContextRuntime({
    memoryResolver: {
      retrieve: async () => {
        throw new Error("should not be called once aborted");
      },
      captureTurn: async () => undefined,
    },
    memoryRetrievalTimeoutMs: 100,
  });
  const context = await runtime.prepareForModel({
    ...baseInput,
    abortSignal: controller.signal,
  });
  assert.equal(context.diagnostics.filter((d) => d.code === "memory_provider_error").length, 0);
});
