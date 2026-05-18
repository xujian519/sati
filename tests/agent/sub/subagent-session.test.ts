import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  SUBAGENT_DEFINITIONS,
  SubAgentSession,
} from "../../../src/agent/sub/index.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../../src/model/index.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { SequentialToolScheduler } from "../../../src/tool/scheduler/SequentialToolScheduler.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
} from "../../../src/permission/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import {
  createReadFileTool,
  createWriteFileTool,
  type PilotDeckReadFileStateMap,
  type PilotDeckWriteSnapshotMap,
} from "../../../src/tool/index.js";
import { createPilotDeckTempWorkspace } from "../../helpers/filesystem.js";

class ScriptedModel {
  readonly requests: CanonicalModelRequest[] = [];
  constructor(private readonly events: CanonicalModelEvent[]) {}
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    for (const event of this.events) yield event;
  }
}

function buildDeps(model: ScriptedModel, registry: ToolRegistry): AgentRuntimeDependencies {
  const permissions = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissions);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  // Adapt the ScriptedModel into the router-shaped surface the agent loop now
  // consumes — tests don't exercise scenario routing / fallback, so the shim
  // just forwards `stream(request)` and ignores the routing context.
  const router = {
    stream: (request: CanonicalModelRequest) => model.stream(request),
  };
  return { router, tools: { scheduler, registry } };
}

function buildConfig(cwd: string): AgentRuntimeConfig {
  return {
    provider: "edgeclaw",
    model: "moonshotai/kimi-k2.6",
    cwd,
    systemPrompt: "Parent prompt.\n<claude-md>secrets</claude-md>\n",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "default",
      canPrompt: false,
    }),
    maxOutputTokens: 1024,
  };
}

const finalReport = [
  "Scope: Investigated the prompt.",
  "Result: Confirmed.",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

test("C2.E2E SubAgentSession.run drives one assistant message and returns a parsed report", async () => {
  const events: CanonicalModelEvent[] = [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: finalReport },
    { type: "message_end", finishReason: "stop" },
    { type: "usage", usage: { inputTokens: 50, outputTokens: 80 } },
  ];
  const model = new ScriptedModel(events);
  const registry = new ToolRegistry();
  const config = buildConfig("/tmp/proj");
  const deps = buildDeps(model, registry);
  const parentMessages: CanonicalMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "research request" }],
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", text: "..." },
        { type: "tool_call", id: "call_a", name: "agent", input: {} },
        { type: "text", text: "Calling subagent." },
      ],
    },
  ];

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "Find all references to foo",
    parentMessages,
    parentConfig: config,
    parentDependencies: deps,
    subagentSessionId: "sub-1",
    subagentId: "uuid-1",
  });
  const report = await session.run();
  assert.equal(report.subagentId, "uuid-1");
  assert.equal(report.definitionId, "explore");
  assert.equal(report.markdown.trim(), finalReport);
  assert.equal(report.parsed?.Scope, "Investigated the prompt.");
  assert.equal(report.parsed?.Result, "Confirmed.");
  assert.equal(report.parsed?.["Key files"], "none");

  // S7 — explore drops claudeMd from the system prompt.
  assert.equal(model.requests.length, 1);
  const sysPrompt = model.requests[0].systemPrompt ?? "";
  assert.ok(!sysPrompt.includes("secrets"));
  // Subagent prefix injected.
  assert.match(sysPrompt, /You are a subagent of PilotDeck/);
});

test("C2.E2E SubAgentSession scopes the tool registry per definition.allowedTools", async () => {
  const model = new ScriptedModel([
    { type: "text_delta", text: finalReport },
    { type: "message_end", finishReason: "stop" },
  ]);
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "Read",
    kind: "filesystem",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    execute: async () => ({ content: [{ type: "text", text: "" }] }),
  });
  registry.register({
    name: "edit_file",
    description: "Edit",
    kind: "filesystem",
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isDestructive: () => true,
    execute: async () => ({ content: [{ type: "text", text: "" }] }),
  });
  const deps = buildDeps(model, registry);
  const parentMessages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [{ type: "text", text: "trigger" }],
    },
  ];
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.plan,
    directive: "Plan refactor",
    parentMessages,
    parentConfig: buildConfig("/tmp/proj"),
    parentDependencies: deps,
    subagentSessionId: "sub-2",
    subagentId: "uuid-2",
  });
  await session.run();
  // Plan only allows read_file/grep/glob — edit_file must NOT appear in the
  // request's tool list. Confirm via the captured request.
  const request = model.requests[0];
  const toolNames = (request?.tools ?? []).map((t) => t.name);
  assert.ok(toolNames.includes("read_file"));
  assert.ok(!toolNames.includes("edit_file"));
});

test("C2.E2E SubAgentSession returns empty markdown when no assistant text produced", async () => {
  const model = new ScriptedModel([
    { type: "message_end", finishReason: "stop" },
  ]);
  const registry = new ToolRegistry();
  const deps = buildDeps(model, registry);
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "noop",
    parentMessages: [{ role: "assistant", content: [{ type: "text", text: "" }] }],
    parentConfig: buildConfig("/tmp/proj"),
    parentDependencies: deps,
    subagentSessionId: "sub-3",
    subagentId: "uuid-3",
  });
  const report = await session.run();
  assert.equal(report.markdown, "");
  assert.equal(report.parsed, undefined);
});

test("C2.E2E SubAgentSession inherits parent read/write state one-way", async (t) => {
  const workspace = await createPilotDeckTempWorkspace({ "existing.txt": "old" });
  t.after(() => workspace.cleanup());
  const existingPath = path.join(workspace.cwd, "existing.txt");
  const existingStat = await stat(existingPath);
  const existingMtimeMs = Math.floor(existingStat.mtimeMs);
  const parentReadFileState: PilotDeckReadFileStateMap = new Map([
    [`${existingPath}::text::1::all::`, {
      mtimeMs: existingMtimeMs,
      kind: "text",
    }],
  ]);
  const parentWriteSnapshots: PilotDeckWriteSnapshotMap = new Map([
    [existingPath, {
      absolutePath: existingPath,
      mtimeMs: existingMtimeMs,
      contentHash: hashText("old"),
    }],
  ]);
  const writeReport = [
    "Scope: Updated the inherited file.",
    "Result: Wrote the requested contents.",
    "Key files: existing.txt",
    "Files changed: existing.txt",
    "Issues: none",
  ].join("\n");
  const events: CanonicalModelEvent[] = [
    { type: "message_start", role: "assistant" },
    {
      type: "tool_call_end",
      toolCall: {
        id: "call-1",
        name: "write_file",
        input: { file_path: existingPath, content: "child write" },
      },
    },
    { type: "message_end", finishReason: "tool_call" },
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: writeReport },
    { type: "message_end", finishReason: "stop" },
  ];
  const model = new ScriptedModel(events);
  const registry = new ToolRegistry();
  registry.register(createReadFileTool());
  registry.register(createWriteFileTool());
  const config = buildConfig(workspace.cwd);
  config.permissionMode = "acceptEdits";
  config.permissionContext = createDefaultPermissionContext({
    cwd: workspace.cwd,
    mode: "acceptEdits",
    canPrompt: false,
  });
  const deps = buildDeps(model, registry);
  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS["general-purpose"],
    directive: "Rewrite the inherited file.",
    parentMessages: [{ role: "assistant", content: [{ type: "text", text: "trigger" }] }],
    parentConfig: config,
    parentDependencies: deps,
    parentReadFileState,
    parentWriteSnapshots,
    subagentSessionId: "sub-4",
    subagentId: "uuid-4",
  });

  const report = await session.run();

  assert.equal(report.markdown.trim(), writeReport);
  assert.equal(await workspace.read("existing.txt"), "child write");
  assert.equal(parentReadFileState.get(`${existingPath}::text::1::all::`)?.mtimeMs, existingMtimeMs);
  assert.equal(parentWriteSnapshots.get(existingPath)?.contentHash, hashText("old"));
});

function hashText(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
