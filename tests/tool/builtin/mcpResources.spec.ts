import assert from "node:assert/strict";
import test from "node:test";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createListMcpResourcesTool, createReadMcpResourceTool } from "../../../src/tool/builtin/mcpResources.js";

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

test("list_mcp_resources calls the adapter and returns a json block", async () => {
  const calls: (string | undefined)[] = [];
  const def = createListMcpResourcesTool({
    listResources: async (serverId?: string) => {
      calls.push(serverId);
      return [{ uri: "file:///a.txt" }];
    },
    readResource: async () => {
      throw new Error("unused");
    },
  });
  assert.equal(def.name, "list_mcp_resources");
  assert.equal(def.isReadOnly({}), true);
  const out = await def.execute({}, ctx);
  assert.deepEqual(calls, [undefined]);
  assert.deepEqual(out.content, [{ type: "json", value: [{ uri: "file:///a.txt" }] }]);
});

test("list_mcp_resources forwards the optional serverId filter", async () => {
  const calls: (string | undefined)[] = [];
  const def = createListMcpResourcesTool({
    listResources: async (serverId?: string) => {
      calls.push(serverId);
      return [];
    },
    readResource: async () => {
      throw new Error("unused");
    },
  });
  await def.execute({ serverId: "filesystem" }, ctx);
  assert.deepEqual(calls, ["filesystem"]);
});

test("read_mcp_resource calls the adapter with serverId and uri", async () => {
  let seen: { serverId: string; uri: string } | undefined;
  const def = createReadMcpResourceTool({
    listResources: async () => [],
    readResource: async (serverId: string, uri: string) => {
      seen = { serverId, uri };
      return { contents: [{ uri, text: "hello" }] };
    },
  });
  assert.equal(def.name, "read_mcp_resource");
  const out = await def.execute({ serverId: "filesystem", uri: "file:///a.txt" }, ctx);
  assert.deepEqual(seen, { serverId: "filesystem", uri: "file:///a.txt" });
  assert.deepEqual(out.data, { contents: [{ uri: "file:///a.txt", text: "hello" }] });
});

test("read_mcp_resource requires serverId and uri (validateInput)", async () => {
  const def = createReadMcpResourceTool({
    listResources: async () => [],
    readResource: async () => ({}),
  });
  const validation = await def.validateInput?.({}, ctx);
  assert.ok(validation && !validation.ok, "empty input must fail validation");
  assert.deepEqual(validation.issues.map(i => i.path).sort(), ["serverId", "uri"]);
  assert.equal(
    validation.issues.every(i => i.code === "required"),
    true,
  );

  const missingUri = await def.validateInput?.({ serverId: "x" }, ctx);
  assert.ok(missingUri && !missingUri.ok);
  assert.deepEqual(
    missingUri.issues.map(i => i.path),
    ["uri"],
  );

  const valid = await def.validateInput?.({ serverId: "x", uri: "file:///a" }, ctx);
  assert.ok(valid?.ok);
});

test("resource tools throw unsupported_tool when the adapter is not configured", async () => {
  const listDef = createListMcpResourcesTool();
  const readDef = createReadMcpResourceTool();
  for (const def of [listDef, readDef]) {
    await assert.rejects(
      () => def.execute({ serverId: "x", uri: "file:///a" }, ctx),
      (err: unknown) => {
        assert.ok(err instanceof SatiToolRuntimeError);
        assert.equal(err.code, "unsupported_tool");
        return true;
      },
    );
  }
});
