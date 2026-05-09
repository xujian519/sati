import test from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { McpClient, type McpClientOptions } from "../../src/mcp/index.js";
import type { PolitDeckMcpServerSpec } from "../../src/mcp/index.js";

async function buildLinked(serverFactory: () => McpServer): Promise<{
  serverPair: ReturnType<typeof InMemoryTransport.createLinkedPair>;
  server: McpServer;
}> {
  const pair = InMemoryTransport.createLinkedPair();
  const server = serverFactory();
  await server.connect(pair[1]);
  return { serverPair: pair, server };
}

function makeSpec(id: string): PolitDeckMcpServerSpec {
  return { id, transport: "stdio", command: "echo", args: [] } as PolitDeckMcpServerSpec;
}

test("C1.M1+M6 listTools cached on second call", async () => {
  const calls = { list: 0 };
  const { serverPair, server } = await buildLinked(() => {
    const s = new McpServer({ name: "echo", version: "0.0.1" });
    s.tool(
      "ping",
      "Echo back",
      { msg: z.string() },
      async ({ msg }) => ({ content: [{ type: "text", text: msg }] }),
    );
    return s;
  });

  const transportFactory: McpClientOptions["transportFactory"] = () => serverPair[0];
  const client = new McpClient(makeSpec("echo"), { transportFactory });
  try {
    const tools1 = await client.listTools();
    assert.equal(tools1.length, 1);
    assert.equal(tools1[0].toolName, "ping");
    assert.equal(tools1[0].wireName, "mcp__echo__ping");
    assert.equal(tools1[0].description, "Echo back");

    const tools2 = await client.listTools();
    assert.equal(tools2, tools1);
  } finally {
    await client.close();
    await server.close();
  }
  void calls;
});

test("C1.M3+M11 callTool routes args and sanitizes results", async () => {
  const { serverPair, server } = await buildLinked(() => {
    const s = new McpServer({ name: "echo", version: "0.0.1" });
    s.tool(
      "shout",
      { msg: z.string() },
      async ({ msg }) => ({
        content: [{ type: "text", text: `${msg}\u200B!` }],
      }),
    );
    return s;
  });
  const client = new McpClient(makeSpec("echo"), {
    transportFactory: () => serverPair[0],
  });
  try {
    await client.start();
    const out = await client.callTool("shout", { msg: "hi" }, {});
    const content = out.content as Array<{ type: string; text: string }>;
    assert.equal(content[0].text, "hi!");
  } finally {
    await client.close();
    await server.close();
  }
});

test("C1.M3 timeout maps to mcp_call_timeout", async () => {
  const { serverPair, server } = await buildLinked(() => {
    const s = new McpServer({ name: "slow", version: "0.0.1" });
    s.tool(
      "sleep",
      { ms: z.number() },
      async ({ ms }) => {
        await new Promise((r) => setTimeout(r, ms));
        return { content: [{ type: "text", text: "done" }] };
      },
    );
    return s;
  });
  const client = new McpClient(makeSpec("slow"), {
    transportFactory: () => serverPair[0],
    callTimeoutMs: 50,
  });
  try {
    await client.start();
    await assert.rejects(
      () => client.callTool("sleep", { ms: 500 }, { timeoutMs: 50 }),
      (err: Error & { code?: string }) => err.code === "mcp_call_timeout",
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("C1 listTools surfaces description truncation marker for huge tools", async () => {
  const huge = "x".repeat(5000);
  const { serverPair, server } = await buildLinked(() => {
    const s = new McpServer({ name: "big", version: "0.0.1" });
    s.tool(
      "huge",
      huge,
      { v: z.string() },
      async ({ v }) => ({ content: [{ type: "text", text: v }] }),
    );
    return s;
  });
  const client = new McpClient(makeSpec("big"), {
    transportFactory: () => serverPair[0],
  });
  try {
    const tools = await client.listTools();
    assert.equal(tools.length, 1);
    assert.ok(tools[0].description.includes("[truncated]"));
    assert.ok(tools[0].description.length < huge.length);
  } finally {
    await client.close();
    await server.close();
  }
});
