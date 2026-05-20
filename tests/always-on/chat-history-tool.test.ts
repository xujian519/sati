import assert from "node:assert/strict";
import test from "node:test";
import {
  createAlwaysOnChatHistoryTool,
  ALWAYS_ON_CHAT_HISTORY_TOOL_NAME,
} from "../../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import { AlwaysOnRunContextRegistry } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import type { DiscoveryRunContext } from "../../src/always-on/runtime/AlwaysOnRunContextRegistry.js";
import type { PilotDeckToolRuntimeContext } from "../../src/tool/protocol/types.js";

test("tool name is always_on_read_chat_history", () => {
  assert.equal(ALWAYS_ON_CHAT_HISTORY_TOOL_NAME, "always_on_read_chat_history");
});

test("tool rejects non-discovery sessions", async () => {
  const runContexts = new AlwaysOnRunContextRegistry();
  const tool = createAlwaysOnChatHistoryTool({ runContexts });

  const fakeContext = { sessionId: "web:non-existent" } as PilotDeckToolRuntimeContext;

  await assert.rejects(
    () => tool.execute({ sessionId: "web:s_abc" }, fakeContext),
    (error: Error) => {
      assert.ok(error.message.includes("only available during Always-On discovery"));
      return true;
    },
  );
});

test("tool rejects workspace-phase sessions", async () => {
  const runContexts = new AlwaysOnRunContextRegistry();
  const sessionKey = "always-on/workspace:project=foo:run=r1";

  runContexts.register({
    kind: "workspace",
    sessionKey,
    runId: "r1",
    projectKey: "/projects/foo",
    paths: { pilotHome: "/tmp", projectKey: "/projects/foo", projectId: "foo", rootDir: "/tmp/ao", projectDir: "/tmp/ao/projects/foo", plansDir: "/tmp/ao/plans", planIndexFile: "/tmp/ao/plans/index.json", worktreesDir: "/tmp/ao/wt", snapshotsDir: "/tmp/ao/snap", reportsDir: "/tmp/ao/reports", runsDir: "/tmp/ao/runs", runHistoryFile: "/tmp/ao/history.jsonl", eventsFile: "/tmp/ao/events.jsonl", stateFile: "/tmp/ao/state.json", locksDir: "/tmp/ao/locks", discoveryLockFile: "/tmp/ao/locks/discovery.lock" },
    workspaceRegistry: {} as never,
    stateStore: {} as never,
    now: () => new Date(),
  });

  const tool = createAlwaysOnChatHistoryTool({ runContexts });
  const ctx = { sessionId: sessionKey } as PilotDeckToolRuntimeContext;

  await assert.rejects(
    () => tool.execute({ sessionId: "web:s_abc" }, ctx),
    (error: Error) => {
      assert.ok(error.message.includes("only available during Always-On discovery"));
      return true;
    },
  );
});

test("tool is read-only and concurrency-safe", () => {
  const runContexts = new AlwaysOnRunContextRegistry();
  const tool = createAlwaysOnChatHistoryTool({ runContexts });

  assert.equal(tool.isReadOnly({ sessionId: "any" }), true);
  assert.equal(tool.isConcurrencySafe({ sessionId: "any" }), true);
});

test("tool input schema requires sessionId", () => {
  const runContexts = new AlwaysOnRunContextRegistry();
  const tool = createAlwaysOnChatHistoryTool({ runContexts });

  assert.deepStrictEqual(tool.inputSchema.required, ["sessionId"]);
  assert.ok(tool.inputSchema.properties?.sessionId);
});
