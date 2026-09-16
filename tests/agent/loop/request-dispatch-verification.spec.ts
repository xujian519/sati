import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { CanonicalModelEvent, CanonicalModelRequest, ModelRuntime } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import type { RouterModelRef } from "../../../src/router/config/schema.js";
import {
  createRouterRuntime,
  type RouterDecision,
  type RouterExecuteContext,
  type RouterTransformTag,
} from "../../../src/router/index.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

/**
 * 请求侧对拍的**生产接线**测试（issue #360）。
 *
 * 旧实现里 AgentLoop 用同一对 `(request, decision)` 既生成快照又比对，恒真。现在
 * 对拍发生在 router 的派发点：报告给出实际请求，AgentLoop 要求差异只落在本次派发
 * 声明的改写字段内。本 spec 走**真实入口**（AgentLoop → RouterRuntime → 派发点），
 * 钉死两件事：
 *  1. 派发点的未声明差异真的会让回合失败（判据被接线，不是摆设）；
 *  2. 合法改写（输出上限被模型能力夹取）零误报。
 */

const PRIMARY: RouterModelRef = { id: "main/primary-model", provider: "main", model: "primary-model" };

function agentConfig(overrides: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  return {
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    cwd: "/workspace/project",
    maxOutputTokens: 1_024,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: "/workspace/project",
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...overrides,
  };
}

function dependenciesWith(router: unknown): AgentRuntimeDependencies {
  return {
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
}

const SUCCESS: CanonicalModelEvent[] = [
  { type: "message_start", role: "assistant" },
  { type: "text_delta", text: "好的" },
  { type: "message_end", finishReason: "stop" },
];

function modelRuntimeWith(maxOutputTokens: number): ModelRuntime {
  return {
    stream: async function* (): AsyncIterable<CanonicalModelEvent> {
      for (const event of SUCCESS) {
        yield event;
      }
    },
    complete: () => {
      throw new Error("complete 不在本 spec 覆盖范围");
    },
    getCapabilities: () => ({ maxContextTokens: 100_000, maxOutputTokens }),
    getMultimodal: () => ({ images: false, input: ["text"] }),
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => undefined,
  } as unknown as ModelRuntime;
}

/** 在「对拍开启」的进程环境下跑一段用例，结束即还原（不污染同进程其他用例）。 */
async function withDispatchVerification<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION;
  process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION = "1";
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION;
    } else {
      process.env.SATI_VERIFY_REQUEST_RECONSTRUCTION = previous;
    }
  }
}

async function runTurn(loop: AgentLoop): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of loop.run({
    sessionId: "session-dispatch-verify",
    turnId: "turn-1",
    messages: [{ role: "user", content: [{ type: "text", text: "帮我分析这份权利要求" }] }],
  })) {
    events.push(event);
  }
  return events;
}

/** 替身 router：在派发点按给定形态上报，其余行为直通。 */
function scriptedRouter(args: {
  decision: RouterDecision;
  dispatched: (request: CanonicalModelRequest) => CanonicalModelRequest;
  transforms: readonly RouterTransformTag[];
}): unknown {
  return {
    async decide() {
      return args.decision;
    },
    execute: (_decision: RouterDecision, request: CanonicalModelRequest, ctx: RouterExecuteContext) =>
      (async function* (): AsyncIterable<CanonicalModelEvent> {
        ctx.onDispatchRequest?.({
          request: args.dispatched(request),
          decision: args.decision,
          transforms: args.transforms,
        });
        for (const event of SUCCESS) {
          yield event;
        }
      })(),
  };
}

test("派发点的未声明改写让回合失败（判据真的被接线）", async () => {
  const decision: RouterDecision = {
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  };

  const events = await withDispatchVerification(() =>
    runTurn(
      new AgentLoop(
        agentConfig(),
        dependenciesWith(
          scriptedRouter({
            decision,
            // 系统提示在派发前被静默改写，且没有任何标签声明它。
            dispatched: request => ({ ...request, systemPrompt: "被替换的系统提示" }),
            transforms: [],
          }),
        ),
      ),
    ),
  );

  const failure = events.find(event => event.type === "stop_failure");
  assert.ok(failure, `期望回合以失败收尾，实际事件：${events.map(event => event.type).join(",")}`);
  assert.match(failure.error, /undeclared field\(s\): systemPromptDigest/);
});

test("声明的改写零误报：回合正常完成", async () => {
  const decision: RouterDecision = {
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  };

  const events = await withDispatchVerification(() =>
    runTurn(
      new AgentLoop(
        agentConfig({ maxOutputTokens: 10_000 }),
        dependenciesWith(
          scriptedRouter({
            decision,
            dispatched: request => ({ ...request, maxOutputTokens: 4_096 }),
            transforms: ["maxOutputTokensClamped"],
          }),
        ),
      ),
    ),
  );

  assert.equal(
    events.filter(event => event.type === "stop_failure").length,
    0,
    `已声明的改写不得触发失败，实际事件：${events.map(event => event.type).join(",")}`,
  );
  const completed = events.find(event => event.type === "turn_completed");
  assert.ok(completed, "回合应正常完成");
});

test("真实路由链路：模型能力夹取输出上限属已声明改写，零误报", async () => {
  const router = createRouterRuntime(
    {
      enabled: true,
      scenarios: { default: PRIMARY },
      transientRetry: { enabled: false, maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    },
    { modelRuntime: modelRuntimeWith(4_096), now: () => new Date(0), events: { emit: () => undefined } },
  );

  const events = await withDispatchVerification(() =>
    runTurn(new AgentLoop(agentConfig({ maxOutputTokens: 10_000 }), dependenciesWith(router))),
  );

  assert.equal(
    events.filter(event => event.type === "stop_failure").length,
    0,
    `夹取是已声明改写，不应失败，实际事件：${events.map(event => event.type).join(",")}`,
  );
  assert.ok(events.find(event => event.type === "turn_completed"));
});

test("对拍关闭时派发点不再参与判定（默认零开销路径）", async () => {
  const decision: RouterDecision = {
    provider: PRIMARY.provider,
    model: PRIMARY.model,
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "scenario",
    mutations: {},
  };

  const events = await runTurn(
    new AgentLoop(
      agentConfig(),
      dependenciesWith(
        scriptedRouter({
          decision,
          dispatched: request => ({ ...request, systemPrompt: "被替换的系统提示" }),
          transforms: [],
        }),
      ),
    ),
  );

  assert.ok(
    events.find(event => event.type === "turn_completed"),
    "开关未开启时同一个未声明改写不参与判定（行为与旧版一致）",
  );
});
