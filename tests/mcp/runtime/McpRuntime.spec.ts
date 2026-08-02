import assert from "node:assert/strict";
import test from "node:test";
import { LATEST_PROTOCOL_VERSION, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { McpRuntime } from "../../../src/mcp/runtime/McpRuntime.js";
import type { SatiMcpServerSpec } from "../../../src/mcp/protocol/types.js";

/**
 * A fake Transport that completes the SDK client handshake in-process, so we
 * can exercise `McpRuntime`/`McpClient` without spawning subprocesses.
 */
function createFakeTransport(options: {
  name: string;
  instructions?: string;
  tools?: unknown[];
  startDelayMs?: number;
  failStart?: boolean;
  resources?: unknown[];
}): Transport {
  let onmessage: Transport["onmessage"];
  let onclose: (() => void) | undefined;
  let onerror: ((error: Error) => void) | undefined;

  const transport: Transport = {
    async start() {
      if (options.failStart) throw new Error(`fake start failure for ${options.name}`);
      if (options.startDelayMs) await new Promise(r => setTimeout(r, options.startDelayMs));
    },
    async send(message: JSONRPCMessage) {
      const m = message as { id?: number | string; method?: string; params?: { uri?: string } };
      if (m.id === undefined || m.method === undefined) return; // notification — no response
      let result: unknown;
      if (m.method === "initialize") {
        result = {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: { tools: {}, resources: {} },
          serverInfo: { name: options.name, version: "1.0.0" },
          ...(options.instructions !== undefined ? { instructions: options.instructions } : {}),
        };
      } else if (m.method === "tools/list") {
        result = { tools: options.tools ?? [] };
      } else if (m.method === "tools/call") {
        result = { content: [{ type: "text", text: `ok:${options.name}` }] };
      } else if (m.method === "resources/list") {
        result = { resources: options.resources ?? [] };
      } else if (m.method === "resources/read") {
        result = { contents: [{ uri: m.params?.uri, text: `content:${m.params?.uri}` }] };
      } else {
        return; // leave unknown requests unanswered
      }
      onmessage?.({ jsonrpc: "2.0", id: m.id, result } as JSONRPCMessage);
    },
    async close() {
      onclose?.();
    },
    set onmessage(fn) {
      onmessage = fn;
    },
    get onmessage() {
      return onmessage as Transport["onmessage"];
    },
    set onclose(fn) {
      onclose = fn;
    },
    get onclose() {
      return onclose;
    },
    set onerror(fn) {
      onerror = fn;
    },
    get onerror() {
      return onerror;
    },
  };
  return transport;
}

function stdioSpec(id: string): SatiMcpServerSpec {
  return { id, transport: "stdio", command: "node", args: ["-e", ""] };
}

test("McpRuntime.start connects every server and reports ready statuses", async () => {
  const runtime = new McpRuntime([stdioSpec("a"), stdioSpec("b")], {
    clientOptions: { transportFactory: () => createFakeTransport({ name: "fake" }) },
  });
  const statuses = await runtime.start();
  assert.deepEqual(statuses, [
    { serverId: "a", status: "ready" },
    { serverId: "b", status: "ready" },
  ]);
  await runtime.stop();
});

test("McpRuntime.start bounds connect concurrency (M4)", async () => {
  let active = 0;
  let peak = 0;
  const factory = (spec: SatiMcpServerSpec) =>
    createFakeTransport({
      name: spec.id,
      startDelayMs: 40,
    });
  const wrapped = (spec: SatiMcpServerSpec): Transport => {
    const t = factory(spec);
    const originalStart = t.start.bind(t);
    t.start = async () => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await originalStart();
      } finally {
        active -= 1;
      }
    };
    return t;
  };

  const specs = Array.from({ length: 6 }, (_, i) => stdioSpec(`s${i}`));
  const runtime = new McpRuntime(specs, {
    connectConcurrency: 2,
    clientOptions: { transportFactory: wrapped },
  });
  await runtime.start();
  assert.ok(peak <= 2, `expected concurrency <= 2, observed peak ${peak}`);
  assert.equal(peak, 2, `expected the bound to actually be exercised, observed peak ${peak}`);
  await runtime.stop();
});

test("McpRuntime.start captures per-server errors without aborting the rest", async () => {
  const runtime = new McpRuntime([stdioSpec("ok"), stdioSpec("bad"), stdioSpec("ok2")], {
    clientOptions: {
      transportFactory: spec => createFakeTransport({ name: spec.id, failStart: spec.id === "bad" }),
    },
  });
  const statuses = await runtime.start();
  const byId = Object.fromEntries(statuses.map(s => [s.serverId, s]));
  assert.equal(byId.ok?.status, "ready");
  assert.equal(byId.ok2?.status, "ready");
  assert.equal(byId.bad?.status, "error");
  assert.match(byId.bad?.error ?? "", /fake start failure/);
  await runtime.stop();
});

test("McpRuntime.listAllTools aggregates only ready clients", async () => {
  const runtime = new McpRuntime([stdioSpec("with-tools"), stdioSpec("broken")], {
    clientOptions: {
      transportFactory: spec =>
        createFakeTransport({
          name: spec.id,
          tools:
            spec.id === "with-tools"
              ? [{ name: "echo", description: "echo", inputSchema: { type: "object" } }]
              : undefined,
          failStart: spec.id === "broken",
        }),
    },
  });
  await runtime.start();
  const tools = await runtime.listAllTools();
  assert.equal(tools.length, 1);
  assert.equal(tools[0]?.serverId, "with-tools");
  assert.equal(tools[0]?.toolName, "echo");
  await runtime.stop();
});

test("McpRuntime.getInstructions returns instructions of ready servers, sorted by id", async () => {
  const runtime = new McpRuntime([stdioSpec("b"), stdioSpec("a")], {
    clientOptions: {
      transportFactory: spec => createFakeTransport({ name: spec.id, instructions: `instructions for ${spec.id}` }),
    },
  });
  await runtime.start();
  const instructions = runtime.getInstructions();
  assert.deepEqual(instructions, [
    { serverId: "a", instructions: "instructions for a" },
    { serverId: "b", instructions: "instructions for b" },
  ]);
  await runtime.stop();
});

test("McpRuntime.getInstructions skips servers without instructions", async () => {
  const runtime = new McpRuntime([stdioSpec("quiet"), stdioSpec("loud")], {
    clientOptions: {
      transportFactory: spec =>
        createFakeTransport({
          name: spec.id,
          instructions: spec.id === "loud" ? "loud instructions" : undefined,
        }),
    },
  });
  await runtime.start();
  const instructions = runtime.getInstructions();
  assert.deepEqual(instructions, [{ serverId: "loud", instructions: "loud instructions" }]);
  await runtime.stop();
});

test("McpRuntime.statuses reports all clients, including failed ones", async () => {
  const runtime = new McpRuntime([stdioSpec("ok"), stdioSpec("bad")], {
    clientOptions: {
      transportFactory: spec => createFakeTransport({ name: spec.id, failStart: spec.id === "bad" }),
    },
  });
  await runtime.start();
  const statuses = runtime.statuses();
  const byId = Object.fromEntries(statuses.map(s => [s.serverId, s]));
  assert.equal(byId.ok?.status, "ready");
  assert.equal(byId.bad?.status, "error");
  await runtime.stop();
});

test("McpRuntime.stop closes every client and leaves them idle", async () => {
  const closed: string[] = [];
  const runtime = new McpRuntime([stdioSpec("a"), stdioSpec("b")], {
    clientOptions: {
      transportFactory: spec => {
        const t = createFakeTransport({ name: spec.id });
        const originalClose = t.close.bind(t);
        t.close = async () => {
          closed.push(spec.id);
          await originalClose();
        };
        return t;
      },
    },
  });
  await runtime.start();
  await runtime.stop();
  assert.deepEqual(closed.sort(), ["a", "b"]);
  assert.deepEqual(runtime.statuses(), [
    { serverId: "a", status: "idle" },
    { serverId: "b", status: "idle" },
  ]);
});

test("McpRuntime handles an empty server list", async () => {
  const runtime = new McpRuntime([]);
  assert.deepEqual(await runtime.start(), []);
  assert.deepEqual(runtime.statuses(), []);
  await runtime.stop();
});

test("McpRuntime.listResources aggregates ready clients and filters by serverId", async () => {
  const runtime = new McpRuntime([stdioSpec("a"), stdioSpec("b"), stdioSpec("broken")], {
    clientOptions: {
      transportFactory: spec =>
        createFakeTransport({
          name: spec.id,
          resources: spec.id === "a" ? [{ uri: "file:///a.txt", name: "a" }] : [],
          failStart: spec.id === "broken",
        }),
    },
  });
  await runtime.start();

  const all = await runtime.listResources();
  assert.deepEqual(all.map(e => e.serverId).sort(), ["a", "b"], "broken client must be skipped");
  assert.deepEqual(all.find(e => e.serverId === "a")?.resources, [{ uri: "file:///a.txt", name: "a" }]);

  const onlyA = await runtime.listResources("a");
  assert.deepEqual(
    onlyA.map(e => e.serverId),
    ["a"],
  );

  const none = await runtime.listResources("missing");
  assert.deepEqual(none, []);
  await runtime.stop();
});

test("McpRuntime.readResource reads from a specific ready client", async () => {
  const runtime = new McpRuntime([stdioSpec("a")], {
    clientOptions: { transportFactory: spec => createFakeTransport({ name: spec.id }) },
  });
  await runtime.start();
  const result = await runtime.readResource("a", "file:///x.txt");
  assert.deepEqual(result.contents, [{ uri: "file:///x.txt", text: "content:file:///x.txt" }]);
  await runtime.stop();
});

test("McpRuntime.readResource rejects unknown or non-ready servers", async () => {
  const runtime = new McpRuntime([stdioSpec("broken")], {
    clientOptions: { transportFactory: spec => createFakeTransport({ name: spec.id, failStart: true }) },
  });
  await runtime.start();
  await assert.rejects(() => runtime.readResource("missing", "file:///x"), /not registered/);
  await assert.rejects(() => runtime.readResource("broken", "file:///x"), /not ready/);
  await runtime.stop();
});
