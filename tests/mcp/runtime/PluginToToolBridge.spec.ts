import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createMcpToolDefinitionsFromRuntime } from "../../../src/mcp/runtime/PluginToToolBridge.js";
import type { McpRuntime } from "../../../src/mcp/runtime/McpRuntime.js";
import type { McpClient } from "../../../src/mcp/client/McpClient.js";
import type { SatiMcpToolSpec } from "../../../src/mcp/protocol/types.js";

const STDIO_SPEC = { id: "filesystem", transport: "stdio", command: "node" } as const;

function makeSpec(overrides: Partial<SatiMcpToolSpec> = {}): SatiMcpToolSpec {
  return {
    serverId: "filesystem",
    toolName: "read_file",
    wireName: "mcp__filesystem__read_file",
    description: "Read a file",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    ...overrides,
  };
}

type CallResult = { content: unknown; isError?: boolean };

function makeFakeClient(
  options: { callTool?: (toolName: string, args: unknown, opts: { signal?: AbortSignal }) => Promise<CallResult> } = {},
) {
  const client = {
    spec: STDIO_SPEC,
    callTool: options.callTool ?? (async () => ({ content: [{ type: "text", text: "ok" }] })),
  } as unknown as McpClient;
  return client;
}

function makeFakeRuntime(options: {
  spec: SatiMcpToolSpec;
  client?: McpClient;
  getClient?: (serverId: string) => McpClient | undefined;
}): McpRuntime {
  const runtime = {
    listAllTools: async () => [options.spec],
    getClient: options.getClient ?? (() => options.client ?? makeFakeClient()),
  } as unknown as McpRuntime;
  return runtime;
}

async function buildDef(options: {
  spec?: SatiMcpToolSpec;
  client?: McpClient;
  getClient?: (serverId: string) => McpClient | undefined;
}) {
  const runtime = makeFakeRuntime({
    spec: options.spec ?? makeSpec(),
    client: options.client,
    getClient: options.getClient,
  });
  const defs = await createMcpToolDefinitionsFromRuntime(runtime);
  return defs[0]!;
}

function makeCtx(): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      rules: { allow: [], deny: [], ask: [] },
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
  };
}

const ctx = makeCtx();

test("bridge maps a tool spec onto a SatiToolDefinition", async () => {
  const def = await buildDef({});
  assert.equal(def.name, "mcp__filesystem__read_file");
  assert.equal(def.description, "Read a file");
  assert.equal(def.kind, "mcp");
  assert.deepEqual(def.inputSchema, { type: "object", properties: { path: { type: "string" } } });
  assert.equal(def.maxResultBytes, 200_000);
});

test("bridge reflects annotations onto safety flags (M12)", async () => {
  const def = await buildDef({
    spec: makeSpec({
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    }),
  });
  assert.equal(def.isReadOnly({}), true);
  assert.equal(def.isDestructive?.({}), false);
  assert.equal(def.isOpenWorld?.({}), false);
});

test("bridge defaults openWorld to true when annotations are absent", async () => {
  const def = await buildDef({ spec: makeSpec({ annotations: undefined }) });
  assert.equal(def.isOpenWorld?.({}), true);
  assert.equal(def.isReadOnly({}), false);
});

test("bridge maps text content blocks to Sati text blocks", async () => {
  const client = makeFakeClient({
    callTool: async () => ({
      content: [
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ],
    }),
  });
  const def = await buildDef({ client });
  const out = await def.execute({}, ctx);
  assert.deepEqual(out.content, [
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ]);
  assert.deepEqual(out.metadata?.mcp, {
    serverId: "filesystem",
    toolName: "read_file",
    wireName: "mcp__filesystem__read_file",
  });
  // `data` carries the raw MCP content array untouched.
  assert.deepEqual(out.data, [
    { type: "text", text: "hello" },
    { type: "text", text: "world" },
  ]);
});

test("bridge maps image content blocks to Sati image blocks", async () => {
  const client = makeFakeClient({
    callTool: async () => ({
      content: [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }],
    }),
  });
  const def = await buildDef({ client });
  const out = await def.execute({}, ctx);
  assert.deepEqual(out.content, [{ type: "image", mimeType: "image/png", data: "aW1hZ2U=" }]);
});

test("bridge falls unknown block types through as a single json block", async () => {
  const client = makeFakeClient({
    callTool: async () => ({
      content: [
        { type: "audio", data: "..." },
        { type: "resource", uri: "x" },
      ],
    }),
  });
  const def = await buildDef({ client });
  const out = await def.execute({}, ctx);
  assert.equal(out.content.length, 1);
  assert.equal(out.content[0]?.type, "json");
});

test("bridge throws SatiToolRuntimeError with extracted text when isError is true", async () => {
  const client = makeFakeClient({
    callTool: async () => ({
      isError: true,
      content: [
        { type: "text", text: "first line" },
        { type: "text", text: "second line" },
      ],
    }),
  });
  const def = await buildDef({ client });
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "tool_execution_failed");
      assert.match((err as Error).message, /first line\nsecond line/);
      return true;
    },
  );
});

test("bridge maps mcp_call_timeout to errorCode", async () => {
  const client = makeFakeClient({
    callTool: async () => {
      throw Object.assign(new Error("MCP call timed out"), { code: "mcp_call_timeout" });
    },
  });
  const def = await buildDef({ client });
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "tool_execution_failed");
      assert.equal((err as { details?: { errorCode?: string } }).details?.errorCode, "mcp_call_timeout");
      return true;
    },
  );
});

test("bridge maps mcp_session_expired to errorCode", async () => {
  const client = makeFakeClient({
    callTool: async () => {
      throw Object.assign(new Error("MCP session expired"), { code: "mcp_session_expired" });
    },
  });
  const def = await buildDef({ client });
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal((err as { details?: { errorCode?: string } }).details?.errorCode, "mcp_session_expired");
      return true;
    },
  );
});

test("bridge wraps unknown call errors as mcp_call_failed", async () => {
  const client = makeFakeClient({
    callTool: async () => {
      throw new Error("boom");
    },
  });
  const def = await buildDef({ client });
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal((err as { details?: { errorCode?: string } }).details?.errorCode, "mcp_call_failed");
      assert.match((err as Error).message, /boom/);
      return true;
    },
  );
});

test("bridge throws unsupported_tool when the client is not registered", async () => {
  const def = await buildDef({ getClient: () => undefined });
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "unsupported_tool");
      return true;
    },
  );
});

test("bridge reads markdown-linked image files from stdio cwd (M14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-mcp-bridge-"));
  try {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    writeFileSync(join(dir, "shot.png"), png);
    const client = {
      spec: { ...STDIO_SPEC, cwd: dir },
      callTool: async () => ({
        content: [{ type: "text", text: "![screenshot](./shot.png) done" }],
      }),
    } as unknown as McpClient;
    const def = await buildDef({ client });
    const out = await def.execute({}, ctx);
    const imageBlocks = out.content.filter(c => c.type === "image");
    assert.equal(imageBlocks.length, 1);
    const block = imageBlocks[0] as { mimeType: string; data: string };
    assert.equal(block.mimeType, "image/png");
    assert.deepEqual(Buffer.from(block.data, "base64"), png);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge tolerates unreadable image file references", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sati-mcp-bridge-"));
  try {
    const client = {
      spec: { ...STDIO_SPEC, cwd: dir },
      callTool: async () => ({
        content: [{ type: "text", text: "![missing](./nope.png)" }],
      }),
    } as unknown as McpClient;
    const def = await buildDef({ client });
    const out = await def.execute({}, ctx); // must not throw
    assert.deepEqual(out.content, [{ type: "text", text: "![missing](./nope.png)" }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bridge normalizes malformed input schemas", async () => {
  const def = await buildDef({ spec: makeSpec({ inputSchema: "not-an-object" }) });
  assert.deepEqual(def.inputSchema, { type: "object", additionalProperties: true, properties: {} });
});
