/**
 * 输出上限自愈（W4）测试。
 *
 * 纯函数：各家 400 文案变体解析、非 400/无关键词/已知 maxOutputTokens 优先；
 * requested 未知时取第二大上限形数字。
 * 集成：400 学上限 → 隐形重试（请求 maxOutputTokens 钳到学到的值）→ 成功；
 * 第二次仍 400 走既有错误面（有界一次）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { parseOutputCapRejection } from "../../../src/agent/loop/modelErrors.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelError } from "../../../src/model/protocol/errors.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function error(overrides: Partial<CanonicalModelError>): CanonicalModelError {
  return {
    provider: "test",
    protocol: "openai",
    code: "invalid_request",
    status: 400,
    message: "",
    retryable: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("parseOutputCapRejection：requested 已知，取小于它的最大上限形数字", () => {
  assert.equal(
    parseOutputCapRejection(
      error({ message: "Invalid parameter: max_tokens 32768 > 8192, which is the maximum allowed." }),
      32768,
    ),
    8192,
  );
  assert.equal(
    parseOutputCapRejection(error({ message: "This model supports at most 16384 completion tokens." }), 32768),
    16384,
  );
  assert.equal(parseOutputCapRejection(error({ message: "max_tokens valid range is [1, 8192]" }), 64000), 8192);
  assert.equal(
    parseOutputCapRejection(error({ message: "max_output_tokens must be no more than 64,000" }), 128000),
    64000,
  );
});

test("parseOutputCapRejection：requested 未知，多个上限形数字取第二大", () => {
  assert.equal(
    parseOutputCapRejection(error({ message: "max_tokens 32768 > 8192, which is the maximum" }), undefined),
    8192,
  );
});

test("parseOutputCapRejection：requested 未知，单上限形数字直接采信", () => {
  assert.equal(
    parseOutputCapRejection(error({ message: "this model supports at most 16384 max_tokens" }), undefined),
    16384,
  );
});

test("parseOutputCapRejection：非 400/422 且非 invalid_request 返回 null", () => {
  assert.equal(
    parseOutputCapRejection(error({ status: 429, code: "rate_limit_error", message: "max_tokens 8192" }), 32768),
    null,
  );
  assert.equal(
    parseOutputCapRejection(error({ status: 500, code: "server_error", message: "max_tokens" }), 32768),
    null,
  );
});

test("parseOutputCapRejection：无 max_tokens 关键词返回 null", () => {
  assert.equal(parseOutputCapRejection(error({ message: "Invalid model name gpt-2024" }), 32768), null);
});

test("parseOutputCapRejection：低于 1024 的数字不构成上限", () => {
  assert.equal(parseOutputCapRejection(error({ message: "max_tokens 100 > 50" }), 32768), null);
});

test("parseOutputCapRejection：错误自带 maxOutputTokens 优先采信", () => {
  assert.equal(parseOutputCapRejection(error({ message: "max_tokens invalid", maxOutputTokens: 4096 }), 32768), 4096);
});

// ---------------------------------------------------------------------------
// AgentLoop 集成
// ---------------------------------------------------------------------------

function createLoop(execute: AgentRouterRuntime["execute"], configOverrides?: Partial<AgentRuntimeConfig>): AgentLoop {
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
    maxOutputTokens: 32768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...configOverrides,
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
        async executeAll() {
          return [];
        },
      },
    },
    context,
  });
}

async function* capRejectionError(): AsyncGenerator<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield {
    type: "error",
    error: error({ message: "Invalid parameter: max_tokens 32768 > 8192, which is the maximum allowed." }),
  };
}

async function* textResponse(text: string): AsyncGenerator<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "text_delta", text };
  yield { type: "message_end", finishReason: "stop" };
}

test("output cap：400 学到上限后隐形重试并钳制请求", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    if (requests.length === 1) {
      yield* capRejectionError();
    } else {
      yield* textResponse("done");
    }
  });
  const events: Array<{ type: string; code?: string }> = [];
  for await (const event of loop.run({
    sessionId: "output-cap",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "写一份总结" }] }],
  })) {
    events.push(event as { type: string; code?: string });
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[1]!.maxOutputTokens, 8192);
  assert.ok(events.some(event => event.type === "warning" && event.code === "output_cap_learned"));
  assert.ok(events.some(event => event.type === "turn_completed"));
  assert.ok(!events.some(event => event.type === "turn_failed"));
});

test("output cap：第二次仍 400 不再重试（有界一次）", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    yield* capRejectionError();
  });
  const completions: Array<{ result?: { type?: string } }> = [];
  for await (const event of loop.run({
    sessionId: "output-cap-2",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "写一份总结" }] }],
  })) {
    if (event.type === "turn_completed") {
      completions.push(event as { result?: { type?: string } });
    }
  }
  // 只有初始请求 + 一次自愈重试，没有第三次请求
  assert.equal(requests.length, 2);
  // 终态结果为 error（走既有错误面收尾）
  assert.equal(completions[0]?.result?.type, "error");
});
