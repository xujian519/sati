import assert from "node:assert/strict";
import test from "node:test";
import { SatiToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { createMcpStatusTool } from "../../../src/tool/builtin/mcpStatus.js";

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

test("mcp_status reports the adapter statuses as a json block", async () => {
  const def = createMcpStatusTool({
    statuses: () => [
      { serverId: "a", status: "ready" },
      { serverId: "b", status: "error" },
    ],
  });
  assert.equal(def.name, "mcp_status");
  assert.equal(def.kind, "mcp");
  assert.equal(def.isReadOnly({}), true);
  const out = await def.execute({}, ctx);
  assert.deepEqual(out.content, [
    {
      type: "json",
      value: [
        { serverId: "a", status: "ready" },
        { serverId: "b", status: "error" },
      ],
    },
  ]);
});

test("mcp_status returns an empty list when no servers are configured", async () => {
  const def = createMcpStatusTool({ statuses: () => [] });
  const out = await def.execute({}, ctx);
  assert.deepEqual(out.data, []);
});

test("mcp_status throws when the adapter is not configured", async () => {
  const def = createMcpStatusTool();
  await assert.rejects(
    () => def.execute({}, ctx),
    (err: unknown) => {
      assert.ok(err instanceof SatiToolRuntimeError);
      assert.equal(err.code, "unsupported_tool");
      return true;
    },
  );
});
