import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUBAGENT_DEFINITIONS,
  SubAgentSession,
} from "../../../src/agent/sub/index.js";
import { JsonlTranscriptWriter } from "../../../src/session/index.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { SequentialToolScheduler } from "../../../src/tool/scheduler/SequentialToolScheduler.js";
import {
  PermissionRuntime,
  createDefaultPermissionContext,
} from "../../../src/permission/index.js";
import type {
  CanonicalMessage,
  CanonicalModelEvent,
  CanonicalModelRequest,
} from "../../../src/model/index.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";

class ScriptedModel {
  readonly requests: CanonicalModelRequest[] = [];
  constructor(private readonly events: CanonicalModelEvent[]) {}
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    for (const event of this.events) yield event;
  }
}

const finalReport = [
  "Scope: investigated.",
  "Result: ok.",
  "Key files: none",
  "Files changed: none",
  "Issues: none",
].join("\n");

function buildDeps(model: ScriptedModel, registry: ToolRegistry): AgentRuntimeDependencies {
  const permissions = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissions);
  const scheduler = new SequentialToolScheduler(toolRuntime);
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
    systemPrompt: "Parent prompt.",
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false }),
    maxOutputTokens: 1024,
  };
}

test("C2+C3 SubAgentSession writes turn-by-turn entries to the sidechain writer", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pilotdeck-c3-"));
  const sidechainPath = join(tmp, "sub.jsonl");
  const sidechain = new JsonlTranscriptWriter({ path: sidechainPath });

  const events: CanonicalModelEvent[] = [
    { type: "message_start", role: "assistant" },
    { type: "text_delta", text: finalReport },
    { type: "message_end", finishReason: "stop" },
  ];
  const model = new ScriptedModel(events);
  const registry = new ToolRegistry();
  const deps = buildDeps(model, registry);

  const parentMessages: CanonicalMessage[] = [
    {
      role: "assistant",
      content: [{ type: "text", text: "trigger" }],
    },
  ];

  const session = new SubAgentSession({
    definition: SUBAGENT_DEFINITIONS.explore,
    directive: "find foo",
    parentMessages,
    parentConfig: buildConfig(tmp),
    parentDependencies: deps,
    subagentSessionId: "subsess-1",
    subagentId: "uuid-1",
    sidechainTranscript: {
      recordAcceptedInput: (s, t, m) => sidechain.recordAcceptedInput(s, t, m),
      recordDurableMessage: (s, t, m) => sidechain.recordDurableMessage(s, t, m),
    },
  });
  const report = await session.run();
  assert.equal(report.markdown.trim(), finalReport);

  // Wait for the writer's chain to flush.
  await new Promise((r) => setTimeout(r, 50));
  const lines = readFileSync(sidechainPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  assert.ok(lines.length >= 2);
  // First entry is the accepted_input forked seed messages.
  assert.equal(lines[0].type, "accepted_input");
  // Followed by at least one assistant_message entry.
  assert.ok(lines.some((entry) => entry.type === "assistant_message"));
});
