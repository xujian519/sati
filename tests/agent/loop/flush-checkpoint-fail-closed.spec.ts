/**
 * durable 边界检查点的 fail-closed 契约（计划 T4：此前无 spec）。
 *
 * 行为实体：`AgentLoop.executeToolCalls` 在工具副作用（写文件/外呼/子代理）执行前
 * `await input.onFlushCheckpoint?.()`——「无法保证持久边界就不发生副作用」（AgentLoop.ts:754-757）。
 * 成对判据：
 *   1. 检查点失败 ⇒ 抛出传播、**工具零执行**（fail-closed）；
 *   2. 检查点成功 ⇒ 先落盘后执行（顺序契约），工具恰好执行一次。
 */
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

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** 一轮工具调用后收尾的最小模型脚本。 */
function toolCallScript(): AgentRouterRuntime["execute"] {
  let requests = 0;
  return async function* () {
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
  };
}

function createLoop(onToolExecute: () => void): AgentLoop {
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
    execute: toolCallScript(),
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
  };
  return new AgentLoop(config, {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll(calls: Array<{ id: string; name: string }>) {
          onToolExecute();
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

async function drain(loop: AgentLoop, onFlushCheckpoint: () => Promise<void>): Promise<void> {
  for await (const _event of loop.run({
    sessionId: "flush-checkpoint-session",
    turnId: "turn-1",
    messages: [userMessage("读一下 a.md")],
    onFlushCheckpoint,
  })) {
    // drain
  }
}

test("检查点失败：抛出传播且工具零执行（fail-closed，不越过持久边界发生副作用）", async () => {
  let toolExecutions = 0;
  const loop = createLoop(() => {
    toolExecutions += 1;
  });

  await assert.rejects(
    drain(loop, async () => {
      throw new Error("flush failed");
    }),
    /flush failed/,
  );
  assert.equal(toolExecutions, 0, "无法保证持久边界时不得执行工具副作用");
});

test("检查点成功：先落盘后执行（顺序契约），工具恰好执行一次且回合正常收尾", async () => {
  const order: string[] = [];
  const loop = createLoop(() => {
    order.push("tool");
  });

  await drain(loop, async () => {
    order.push("flush");
  });

  assert.deepEqual(order, ["flush", "tool"], "必须先在 durable 边界落盘、再执行工具（顺序契约）");
});
