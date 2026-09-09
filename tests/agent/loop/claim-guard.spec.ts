/**
 * 声称-行动守卫（claimGuard）测试（W3）。
 *
 * 纯函数：无支撑声称 → correction；有支撑工具 → pass；无声称 → pass；
 * fenced code 内声称不触发；纠正指令非空且含声称词。
 * 集成（AgentLoop）：开关开启时无支撑声称触发一轮纠正 transient 重试；
 * 支撑工具成功后放行；开关默认关零行为变化。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import { evaluateClaimGuard } from "../../../src/agent/loop/claimGuard.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiToolResult } from "../../../src/tool/protocol/result.js";

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test("evaluateClaimGuard：无支撑声称返回 correction", () => {
  const verdict = evaluateClaimGuard("该方案已验证通过，可以交付。", []);
  assert.equal(verdict.kind, "correction");
  if (verdict.kind === "correction") {
    assert.ok(verdict.claim.length > 0);
    assert.ok(verdict.prompt.includes(verdict.claim));
  }
});

test("evaluateClaimGuard：英文声称同样命中", () => {
  assert.equal(evaluateClaimGuard("I have verified the claims.", []).kind, "correction");
});

test("evaluateClaimGuard：支撑工具成功时放行", () => {
  const verdict = evaluateClaimGuard("已验证通过。", ["read_file", "rule_check"]);
  assert.equal(verdict.kind, "pass");
});

test("evaluateClaimGuard：非支撑工具不构成支撑", () => {
  const verdict = evaluateClaimGuard("已验证通过。", ["read_file", "patent_search"]);
  assert.equal(verdict.kind, "correction");
});

test("evaluateClaimGuard：无声称放行", () => {
  assert.equal(evaluateClaimGuard("以下是对比分析结果。", []).kind, "pass");
});

test("evaluateClaimGuard：fenced code 内声称不触发", () => {
  const text = ["```", "echo 已验证", "```", "分析完成。"].join("\n");
  assert.equal(evaluateClaimGuard(text, []).kind, "pass");
});

test("evaluateClaimGuard：否定式披露不触发（review Important #1）", () => {
  for (const text of [
    "此数据 unverified，需人工复核。",
    "The claim is not verified yet.",
    "The claim is not yet verified.",
    "方案未经测试，存在风险。",
    "未经验证的数据不作为依据。",
    "该指标 (unverified) 仅供参考。",
    "contested findings",
  ]) {
    assert.equal(evaluateClaimGuard(text, []).kind, "pass", text);
  }
});

test("evaluateClaimGuard：肯定式声称仍命中", () => {
  for (const text of ["I have verified the claims.", "已验证通过。", "测试通过。", "经验证无误。"]) {
    assert.equal(evaluateClaimGuard(text, []).kind, "correction", text);
  }
});

// ---------------------------------------------------------------------------
// AgentLoop 集成
// ---------------------------------------------------------------------------

function createLoop(
  execute: AgentRouterRuntime["execute"],
  toolResults: SatiToolResult[],
  configOverrides?: Partial<AgentRuntimeConfig>,
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
          return toolResults;
        },
      },
    },
    context,
  });
}

async function* textResponse(text: string): AsyncGenerator<CanonicalModelEvent> {
  yield { type: "message_start", role: "assistant" };
  yield { type: "text_delta", text };
  yield { type: "message_end", finishReason: "stop" };
}

async function collectEvents(loop: AgentLoop): Promise<Array<{ type: string }>> {
  const events: Array<{ type: string }> = [];
  for await (const event of loop.run({
    sessionId: "claim-guard",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "检查并验证" }] }],
  })) {
    events.push(event);
  }
  return events;
}

test("claim guard：无支撑声称触发一轮纠正后收尾", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(
    async function* (_decision, request) {
      const index = requests.length;
      requests.push(request);
      if (index === 0) {
        yield* textResponse("该方案已验证通过，可以交付。");
      } else {
        yield* textResponse("更正：尚未执行验证，以下为已完成的检查。");
      }
    },
    [],
    { claimGuard: true },
  );
  const events = await collectEvents(loop);
  assert.equal(requests.length, 2);
  const retryRequest = requests[1]!;
  const last = retryRequest.messages.at(-1)?.content[0];
  assert.equal(last?.type, "text");
  assert.match(last?.type === "text" ? last.text : "", /no verification tool succeeded/);
  assert.ok(events.some(event => event.type === "turn_completed"));
});

test("claim guard：纠正轮注入 transient 提示且只触发一次", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(
    async function* (_decision, request) {
      const index = requests.length;
      requests.push(request);
      if (index === 0) {
        yield* textResponse("该方案已验证通过，可以交付。");
      } else {
        // 第二次仍含声称，但每 run 只纠正一次
        yield* textResponse("再次声称已验证。");
      }
    },
    [],
    { claimGuard: true },
  );
  const events = await collectEvents(loop);
  // 第一次纠正发生；第二次声称不再触发（每 run 一次）
  assert.equal(requests.length, 2);
  const retryRequest = requests[1]!;
  const last = retryRequest.messages.at(-1)?.content[0];
  assert.equal(last?.type, "text");
  assert.match(last?.type === "text" ? last.text : "", /no verification tool succeeded/);
  assert.ok(events.some(event => event.type === "turn_completed"));
});

test("claim guard：支撑工具成功后放行", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(
    async function* (_decision, request) {
      const index = requests.length;
      requests.push(request);
      if (index === 0) {
        yield { type: "message_start", role: "assistant" };
        yield { type: "tool_call_start", id: "call-1", name: "rule_check" };
        yield { type: "tool_call_delta", id: "call-1", delta: "{}" };
        yield {
          type: "tool_call_end",
          toolCall: { id: "call-1", name: "rule_check", input: {} },
        };
        yield { type: "message_end", finishReason: "tool_call" };
      } else {
        yield* textResponse("规则检查已验证通过，结论如下。");
      }
    },
    [
      {
        type: "success",
        toolCallId: "call-1",
        toolName: "rule_check",
        content: [{ type: "text", text: "rules ok" }],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    { claimGuard: true },
  );
  const events = await collectEvents(loop);
  assert.equal(requests.length, 2);
  assert.ok(events.some(event => event.type === "turn_completed"));
  assert.ok(!events.some(event => event.type === "turn_failed"));
});

test("claim guard：默认关闭时声称文本直接收尾", async () => {
  const requests: CanonicalModelRequest[] = [];
  const loop = createLoop(async function* (_decision, request) {
    requests.push(request);
    yield* textResponse("该方案已验证通过。");
  }, []);
  const events = await collectEvents(loop);
  assert.equal(requests.length, 1);
  assert.ok(events.some(event => event.type === "turn_completed"));
});
