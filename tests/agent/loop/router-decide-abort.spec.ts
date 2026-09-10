import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../../src/model/index.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import type { RouterConfig } from "../../../src/router/config/schema.js";
import { createRouterRuntime, type RouterEvent } from "../../../src/router/index.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

/**
 * 回合取消必须同步中止在途的路由判官（judge）。
 *
 * `RouterRuntime.decide()` 会把它收到的 `abortSignal` 透传给判官请求，但主调用
 * 方 AgentLoop 曾经不传这个信号 —— 于是用户取消回合后判官仍要跑满超时（默认
 * 5s）才返回，为一个已取消的回合发出降级事件并白烧一次 judge 调用。这里走
 * **真实入口**（AgentLoop → RouterRuntime → 判官）覆盖整条链路。
 */

const routerConfig: RouterConfig = {
  enabled: true,
  scenarios: { default: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" } },
  tokenSaver: {
    enabled: true,
    judge: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" },
    defaultTier: "simple",
    tiers: {
      simple: { model: { id: "judge-provider/judge-model", provider: "judge-provider", model: "judge-model" } },
    },
    judgeTimeoutMs: 500,
  },
};

/** 判官永不主动返回，只在请求被中止时拒绝（透传中止原因）。 */
function pendingUntilAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
  });
}

test("回合取消时判官随之中止，且不发出降级事件", async () => {
  let judgeSignal: AbortSignal | undefined;
  let markJudgeStarted: () => void = () => undefined;
  const judgeStarted = new Promise<void>(resolve => {
    markJudgeStarted = resolve;
  });

  const modelRuntime = {
    complete: (_request: CanonicalModelRequest, options?: { signal?: AbortSignal }) => {
      judgeSignal = options?.signal;
      markJudgeStarted();
      return pendingUntilAbort(options?.signal);
    },
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: "已收到" };
      yield { type: "message_end", finishReason: "stop" };
    },
    getCapabilities: () => ({ maxContextTokens: 8_192 }),
    getMultimodal: () => ({ images: false }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;

  const routerEvents: RouterEvent[] = [];
  const router = createRouterRuntime(routerConfig, {
    modelRuntime,
    now: () => new Date(0),
    events: { emit: event => routerEvents.push(event) },
  });

  const config: AgentRuntimeConfig = {
    provider: "judge-provider",
    model: "judge-model",
    cwd: "/workspace/project",
    maxOutputTokens: 1_024,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  const dependencies = {
    router,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
  } as unknown as AgentRuntimeDependencies;

  const loop = new AgentLoop(config, dependencies);
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const running = (async () => {
    for await (const event of loop.run({
      sessionId: "session-decide-abort",
      turnId: "turn-1",
      abortSignal: controller.signal,
      messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
    })) {
      events.push(event);
    }
  })();

  await judgeStarted;
  controller.abort(new Error("turn cancelled"));
  await running;

  assert.ok(judgeSignal, "判官请求应带上一个可中止的信号");
  assert.equal(judgeSignal.aborted, true, "回合取消后判官请求必须已中止");
  assert.match(String((judgeSignal.reason as Error | undefined)?.message), /turn cancelled/);

  const completed = events.find(event => event.type === "turn_completed");
  assert.ok(completed, `expected the turn to finish, got ${JSON.stringify(events.map(event => event.type))}`);
  assert.equal(completed.result.type, "aborted", "取消的回合应以 aborted 收尾，而不是路由失败");
  assert.equal(
    routerEvents.filter(event => event.type === "sati_router_token_saver_failed").length,
    0,
    "已取消的回合不应记录判官降级事件",
  );
});
