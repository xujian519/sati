/**
 * AgentLoop 插话注入测试（协议 1.6 mid-turn steering）。
 *
 * 覆盖：模型调用边界 drain 注入（消息进入下一次请求、尾部追加）、
 * steer_applied 事件广播、onDurableMessage 落库先于注入、无插话零开销、
 * buildSteerMessage/steerPreview 纯函数形状。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { buildSteerMessage, steerPreview } from "../../../src/agent/loop/steer.js";
import { SteerMailbox } from "../../../src/agent/session/SteerMailbox.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import type { CanonicalMessage } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

test("模型调用边界 drain：插话进入下一次模型请求尾部并广播 steer_applied", async () => {
  const mailbox = new SteerMailbox();
  mailbox.start("turn-1");
  const requests: CanonicalModelRequest[] = [];
  const durable: CanonicalMessage[] = [];
  let scheduledToolCalls = 0;
  const loop = createLoop(
    async function* (_decision, request) {
      requests.push(request);
      if (requests.length === 1) {
        // 第一轮：带工具调用（assembler 由 tool_call_end 产出 toolCall），turn 继续
        yield { type: "message_start", role: "assistant" };
        yield { type: "tool_call_start", id: "call-1", name: "read_file" };
        yield { type: "tool_call_delta", id: "call-1", delta: '{"filePath":"/a.md"}' };
        yield {
          type: "tool_call_end",
          toolCall: { id: "call-1", name: "read_file", input: { filePath: "/a.md" } },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "done" };
      yield { type: "message_end", finishReason: "stop" };
    },
    () => {
      scheduledToolCalls += 1;
    },
    { mailbox, durable },
  );

  const events: Array<{ type: string; steerId?: string }> = [];
  for await (const event of loop.run({
    sessionId: "steer-session",
    turnId: "turn-1",
    messages: [userMessage("读一下 a.md")],
    onDurableMessage: message => {
      durable.push(message);
    },
  })) {
    if (event.type === "tool_calls_detected") {
      // 第一轮工具调用已检出（第一轮请求已构造）：投递插话，
      // 将在第二轮模型调用边界注入。
      const item = mailbox.enqueue("顺便看看 b.md 是否存在");
      assert.ok(item);
    }
    events.push(event);
  }

  assert.equal(requests.length, 2);
  assert.equal(scheduledToolCalls, 1);
  // 插话已注入第二轮请求的消息尾部
  const steerInRequest = requests[1]!.messages.find(
    message => message.metadata?.purpose === "steer" && message.metadata?.steerId,
  );
  assert.ok(steerInRequest);
  const textBlock = steerInRequest.content[0];
  assert.equal(textBlock?.type, "text");
  assert.equal(textBlock?.type === "text" ? textBlock.text : "", "顺便看看 b.md 是否存在");
  // 尾部追加：插话消息是请求的最后一条
  assert.equal(requests[1]!.messages.at(-1), steerInRequest);
  // steer_applied 已广播
  const applied = events.find(event => event.type === "steer_applied");
  assert.ok(applied);
  // 落库先于注入：onDurableMessage 同时持久化 assistant 消息等，
  // 只断言 steer 消息恰好一条且 steerId 与广播事件一致
  const durableSteer = durable.filter(message => message.metadata?.purpose === "steer");
  assert.equal(durableSteer.length, 1);
  assert.equal(durableSteer[0]?.metadata?.steerId, applied.steerId);
  // turn 收尾后邮箱已空
  assert.equal(mailbox.pending().length, 0);
});

test("未接线或空队列时零开销：无 steer_applied、请求消息不含 purpose=steer", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(
    async function* (_decision, request) {
      requests.push(request);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "ok" };
      yield { type: "message_end", finishReason: "stop" };
    },
    () => undefined,
  );

  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "no-steer",
    turnId: "turn-1",
    messages: [userMessage("hi")],
  })) {
    events.push(event);
  }
  assert.equal(requests.length, 1);
  assert.ok(!events.some(event => event.type === "steer_applied"));
  assert.ok(!requests[0]!.messages.some(message => message.metadata?.purpose === "steer"));
});

test("buildSteerMessage：非 synthetic（Web 投影可见）且带 purpose/steerId", () => {
  const message = buildSteerMessage({ steerId: "s-1", text: "插话内容", enqueuedAt: 0 });
  assert.equal(message.role, "user");
  assert.notEqual(message.metadata?.synthetic, true);
  assert.notEqual(message.metadata?.transient, true);
  assert.equal(message.metadata?.purpose, "steer");
  assert.equal(message.metadata?.steerId, "s-1");
});

test("steerPreview：单行化并截断到 160 字符", () => {
  assert.equal(steerPreview("  多行\n文本  "), "多行 文本");
  const long = "x".repeat(200);
  const preview = steerPreview(long);
  assert.equal(preview.length, 161);
  assert.ok(preview.endsWith("…"));
});

function createLoop(
  execute: AgentRouterRuntime["execute"],
  onSchedule: () => void,
  extra?: { mailbox?: SteerMailbox; durable?: CanonicalMessage[] },
): AgentLoop {
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
    execute,
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
          onSchedule();
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
    ...(extra?.mailbox ? { steerSource: extra.mailbox } : {}),
  });
}
