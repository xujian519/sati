import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import {
  McpRuntime,
  createMcpToolDefinitionsFromRuntime,
  type PolitDeckMcpServerSpec,
} from "../../src/mcp/index.js";
import { ToolRegistry } from "../../src/tool/registry/ToolRegistry.js";
import { createPolitDeckToolRuntimeFixture } from "../helpers/tool.js";

async function spawnLinkedServer(serverFactory: () => McpServer) {
  const pair = InMemoryTransport.createLinkedPair();
  const server = serverFactory();
  await server.connect(pair[1]);
  return { server, clientTransport: pair[0] };
}

test("C1.M10+M12 runtime exposes MCP tools through ToolRegistry", async () => {
  const { server, clientTransport } = await spawnLinkedServer(() => {
    const s = new McpServer({ name: "design", version: "0.0.1" });
    s.tool(
      "search",
      "Search components",
      { q: z.string() },
      { readOnlyHint: true, openWorldHint: true },
      async ({ q }) => ({ content: [{ type: "text", text: `search:${q}` }] }),
    );
    s.tool(
      "delete-file",
      "Delete a file",
      { path: z.string() },
      { destructiveHint: true, readOnlyHint: false },
      async () => ({ content: [{ type: "text", text: "deleted" }] }),
    );
    return s;
  });

  const spec: PolitDeckMcpServerSpec = {
    id: "design",
    transport: "stdio",
    command: "echo",
  } as PolitDeckMcpServerSpec;

  const runtime = new McpRuntime([spec], {
    clientOptions: { transportFactory: () => clientTransport },
  });
  try {
    const statuses = await runtime.start();
    assert.equal(statuses.length, 1);
    assert.equal(statuses[0].status, "ready");

    const definitions = await createMcpToolDefinitionsFromRuntime(runtime);
    assert.equal(definitions.length, 2);

    const search = definitions.find((d) => d.name === "mcp__design__search");
    const del = definitions.find((d) => d.name === "mcp__design__delete-file");
    assert.ok(search && del);
    assert.equal(search.kind, "mcp");
    assert.equal(search.isReadOnly({}), true);
    assert.equal(search.isDestructive?.({}), false);
    assert.equal(search.isOpenWorld?.({}), true);

    assert.equal(del.isReadOnly({}), false);
    assert.equal(del.isDestructive?.({}), true);

    const registry = new ToolRegistry();
    for (const def of definitions) registry.register(def);
    assert.equal(registry.list().length, 2);

    const fixture = createPolitDeckToolRuntimeFixture({});
    const abort = new AbortController();
    const result = await search.execute(
      { q: "button" },
      { ...fixture.context, abortSignal: abort.signal },
    );
    assert.equal(result.content?.[0]?.type, "json");
  } finally {
    await runtime.stop();
    await server.close();
  }
});

test("C1 PluginToToolBridge surfaces isError → tool_execution_failed", async () => {
  const { server, clientTransport } = await spawnLinkedServer(() => {
    const s = new McpServer({ name: "broken", version: "0.0.1" });
    s.tool(
      "boom",
      "Always fails",
      {},
      async () => ({
        isError: true,
        content: [{ type: "text", text: "failure detail" }],
      }),
    );
    return s;
  });
  const spec: PolitDeckMcpServerSpec = {
    id: "broken",
    transport: "stdio",
    command: "echo",
  } as PolitDeckMcpServerSpec;

  const runtime = new McpRuntime([spec], {
    clientOptions: { transportFactory: () => clientTransport },
  });
  try {
    await runtime.start();
    const defs = await createMcpToolDefinitionsFromRuntime(runtime);
    const boom = defs[0];
    const fixture = createPolitDeckToolRuntimeFixture({});
    const abort = new AbortController();
    await assert.rejects(
      () => boom.execute({}, { ...fixture.context, abortSignal: abort.signal }),
      (err: Error & { code?: string }) => {
        assert.equal(err.name, "PolitDeckToolRuntimeError");
        assert.equal(err.code, "tool_execution_failed");
        return true;
      },
    );
  } finally {
    await runtime.stop();
    await server.close();
  }
});
