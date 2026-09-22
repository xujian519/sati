import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../../src/model/protocol/canonical.js";

/**
 * 循环 → 上下文运行时的「真实工具轮」信号（压缩空转判据的数据源）。
 *
 * 这条接线是承重的：计数器若永远为 0，熔断会在两次压缩后打开且**再也无法关闭**
 * （门槛条件要求「距上次压缩已有工具轮」），正常压缩需求会被永久拒绝。
 */
function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function createLoop(modelReplies: AgentRouterRuntime["execute"], onToolTurn: () => void): AgentLoop {
  const router: AgentRouterRuntime = {
    invalidateSticky: () => ({ orchestrating: false }),
    decide: async ({ request }) => ({
      provider: request.provider,
      model: request.model,
      scenarioType: "default",
      isSubagent: false,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    }),
    execute: modelReplies,
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_end", finishReason: "stop" };
    },
    materializeRequest: (decision, request) => ({ ...request, provider: decision.provider, model: decision.model }),
    observeUsage: () => undefined,
  };
  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/workspace/project",
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
  const context: AgentRuntimeDependencies["context"] = {
    prepareForModel: async input => ({
      messages: input.messages,
      systemPrompt: undefined,
      systemPromptParts: [],
      tools: input.tools,
      diagnostics: [],
      boundaries: [],
    }),
    applyToolResults: async input => ({ messages: input.messages, diagnostics: [] }),
    recoverFromModelError: async () => ({ type: "give_up", reason: "test" }),
    captureTurn: async () => undefined,
    noteToolTurn: onToolTurn,
  };
  return new AgentLoop(config, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls: Array<{ id: string; name: string }>) {
          return calls.map(call => ({
            type: "success" as const,
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text" as const, text: `read ${call.name}` }],
            startedAt: "2026-01-01T00:00:00.000Z",
            completedAt: "2026-01-01T00:00:01.000Z",
          }));
        },
      },
    },
    context,
  });
}

async function drainTurn(loop: AgentLoop): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "tool-turn-session",
    turnId: "turn-1",
    messages: [userMessage("读一下 a.md")],
  })) {
    events.push(event);
  }
  return events;
}

test("工具批执行完上报一次工具轮（压缩空转判据的数据源）", async () => {
  let turns = 0;
  let requests = 0;
  const loop = createLoop(
    async function* () {
      requests += 1;
      yield { type: "message_start", role: "assistant" };
      if (requests === 1) {
        yield {
          type: "tool_call_end",
          toolCall: { id: "call-1", name: "read_file", input: { filePath: "/a.md" } },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    () => {
      turns += 1;
    },
  );

  const events = await drainTurn(loop);

  assert.ok(events.some(event => event.type === "tool_calls_detected"));
  assert.equal(turns, 1);
});

test("纯文本回合零上报（没有工具批就没有推进证据）", async () => {
  let turns = 0;
  const loop = createLoop(
    async function* () {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    () => {
      turns += 1;
    },
  );

  await drainTurn(loop);

  assert.equal(turns, 0);
});
