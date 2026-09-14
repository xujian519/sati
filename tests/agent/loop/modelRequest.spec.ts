import assert from "node:assert/strict";
import test from "node:test";
import {
  createBudgetEvaluator,
  createModelRequest,
  type ModelRequestDeps,
} from "../../../src/agent/loop/modelRequest.js";
import { TurnRuntimeState } from "../../../src/agent/loop/turnRuntimeState.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeDependencies,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { TokenBudgetSnapshot } from "../../../src/context/index.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type { CanonicalMessage, CanonicalModelRequest } from "../../../src/model/index.js";

/**
 * 模型请求装配行为基线（AgentLoop 拆解；issue #147 / TD-SIZE-001）。
 *
 * 覆盖：装配出的请求骨架、「模型可见 = 已记录」注入纪律（真实路径落库、
 * 预算预演不落库不广播、同 turn 去重）、plan 模式提醒、预算评估器的短路与
 * 取大语义。
 */

const CWD = "/workspace/project";

function user(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function baseInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return { sessionId: "s1", turnId: "t1", messages: [user("hi")], ...overrides };
}

interface Fixture {
  deps: ModelRequestDeps;
  lifecycle: string[];
  events: unknown[];
  prepared: unknown[];
  compactPrepares: number;
}

function makeFixture(
  options: {
    config?: Partial<AgentRuntimeConfig>;
    injections?: Array<{ source: string; text: string }>;
    materializeRequest?: AgentRouterRuntime["materializeRequest"];
    tokenAccounting?: AgentRuntimeDependencies["tokenAccounting"];
  } = {},
): Fixture {
  const lifecycle: string[] = [];
  const events: unknown[] = [];
  const prepared: unknown[] = [];
  const fixture: Fixture = {
    deps: undefined as unknown as ModelRequestDeps,
    lifecycle,
    events,
    prepared,
    compactPrepares: 0,
  };

  const config: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: CWD,
    maxContextTokens: 32_768,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd: CWD,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
    ...options.config,
  };

  const dependencies: AgentRuntimeDependencies = {
    router: {
      stream: async function* () {},
      decide: async () => ({}) as never,
      execute: async function* () {},
      ...(options.materializeRequest ? { materializeRequest: options.materializeRequest } : {}),
    } as unknown as AgentRouterRuntime,
    tools: {
      registry: new ToolRegistry(),
      scheduler: {
        async executeAll() {
          return [];
        },
      },
    },
    tokenAccounting: options.tokenAccounting,
    context: {
      prepareForModel: async input => {
        fixture.prepared.push(input);
        if (input.previewOnly) fixture.compactPrepares++;
        return {
          messages: input.messages,
          systemPrompt: "sys prompt",
          systemPromptParts: [],
          tools: input.tools,
          diagnostics: [],
          boundaries: [],
          injections: options.injections,
        };
      },
      applyToolResults: async input => ({ messages: input.messages, diagnostics: [] }),
    },
    eventEmitter: event => {
      events.push(event);
    },
  };

  fixture.deps = {
    config,
    dependencies,
    dispatchLifecycle: async (_input, event) => {
      lifecycle.push(event);
      return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
    },
  };
  return fixture;
}

function budgetSnapshot(tokens: number): TokenBudgetSnapshot {
  return {
    tokens,
    maxContextTokens: 1000,
    warningRatio: 0.8,
    blockingRatio: 0.95,
    state: "ok",
    ratio: tokens / 1000,
  };
}

// ---------------------------------------------------------------------------
// createModelRequest
// ---------------------------------------------------------------------------

test("createModelRequest：装配请求骨架并把 turnId 并入 metadata", async () => {
  const f = makeFixture();

  const request = await createModelRequest(f.deps, [user("hello")], baseInput());

  assert.equal(request.provider, "test");
  assert.equal(request.model, "test-model");
  assert.equal(request.systemPrompt, "sys prompt");
  assert.equal(request.stream, true);
  assert.deepEqual(request.metadata?.turnId, "t1");
  assert.equal(request.messages.length, 1);
});

test("createModelRequest：真实路径发 instructions_loaded 并落注入审计", async () => {
  const f = makeFixture({ injections: [{ source: "memory", text: "remembered" }] });
  const reported: unknown[] = [];

  await createModelRequest(f.deps, [user("hi")], baseInput({ onInjectedContext: entry => void reported.push(entry) }));

  assert.deepEqual(f.lifecycle, ["InstructionsLoaded"]);
  assert.deepEqual(
    f.events.map(event => (event as { type: string }).type),
    ["instructions_loaded"],
  );
  assert.equal(reported.length, 1);
  assert.deepEqual(reported[0], { injections: [{ source: "memory", text: "remembered" }] });
});

test("createModelRequest：预算预演不广播、不落注入审计", async () => {
  const f = makeFixture({ injections: [{ source: "memory", text: "remembered" }] });
  const reported: unknown[] = [];

  const request = await createModelRequest(
    f.deps,
    [user("hi")],
    baseInput({ onInjectedContext: entry => void reported.push(entry) }),
    {
      emitInstructionEvents: false,
      previewOnly: true,
    },
  );

  assert.deepEqual(f.lifecycle, []);
  assert.deepEqual(f.events, []);
  assert.deepEqual(reported, []);
  assert.equal(request.provider, "test");
});

test("createModelRequest：同 turn 内相同 source+text 注入只落库一次", async () => {
  const f = makeFixture({ injections: [{ source: "memory", text: "remembered" }] });
  const reported: Array<{ injections: unknown[] }> = [];
  const input = baseInput({ onInjectedContext: entry => void reported.push(entry as { injections: unknown[] }) });

  const state = new TurnRuntimeState(input, {}, "2026-09-14T00:00:00.000Z");
  await createModelRequest(f.deps, [user("hi")], input, { state });
  await createModelRequest(f.deps, [user("hi")], input, { state });

  assert.equal(reported.length, 1);
});

test("createModelRequest：plan 模式在消息尾部追加计划提醒", async () => {
  const f = makeFixture({
    config: {
      permissionMode: "plan",
      permissionContext: createDefaultPermissionContext({
        cwd: CWD,
        mode: "plan",
        canPrompt: true,
        bypassAvailable: false,
      }),
    },
  });

  const request = await createModelRequest(f.deps, [user("hi")], baseInput());
  const plain = await createModelRequest(makeFixture().deps, [user("hi")], baseInput());

  assert.equal(request.messages.length > plain.messages.length, true);
});

// ---------------------------------------------------------------------------
// createBudgetEvaluator
// ---------------------------------------------------------------------------

test("createBudgetEvaluator：无 tokenAccounting 或无上下文上限时返回 undefined", () => {
  assert.equal(
    createBudgetEvaluator(makeFixture().deps, baseInput(), { maxContextTokens: 1000, reservedOutputTokens: 0 }),
    undefined,
  );

  const withAccounting = makeFixture({
    tokenAccounting: {
      evaluateRequestBudget: async () => budgetSnapshot(10),
      snapshotFromTokens: () => budgetSnapshot(10),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });
  assert.equal(createBudgetEvaluator(withAccounting.deps, baseInput(), { reservedOutputTokens: 0 }), undefined);
});

test("createBudgetEvaluator：以预演请求估算预算（不落注入审计）", async () => {
  const calls: unknown[] = [];
  const f = makeFixture({
    injections: [{ source: "memory", text: "remembered" }],
    tokenAccounting: {
      evaluateRequestBudget: async (request: unknown, options: unknown) => {
        calls.push({ request, options });
        return budgetSnapshot(1234);
      },
      snapshotFromTokens: () => budgetSnapshot(-1),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });

  const evaluator = createBudgetEvaluator(f.deps, baseInput(), {
    maxContextTokens: 8000,
    reservedOutputTokens: 512,
  });
  const snapshot = await evaluator!([user("candidate")], undefined);

  assert.equal(snapshot.tokens, 1234);
  assert.equal(f.compactPrepares, 1);
  const sent = calls[0] as { request: CanonicalModelRequest; options: Record<string, unknown> };
  assert.equal(sent.request.provider, "test");
  assert.equal(sent.request.model, "test-model");
  assert.deepEqual(sent.request.messages, [user("candidate")]);
  assert.equal(sent.request.systemPrompt, "sys prompt");
  assert.deepEqual(sent.options, {
    maxContextTokens: 8000,
    reservedOutputTokens: 512,
    signal: undefined,
    usePadding: true,
  });
});

test("createBudgetEvaluator：路由模型物化 + 用量大于估算时取用量", async () => {
  const materialized: unknown[] = [];
  const f = makeFixture({
    materializeRequest: ((_decision: unknown, request: CanonicalModelRequest) => {
      materialized.push(request);
      return { ...request, model: "routed-model" };
    }) as AgentRouterRuntime["materializeRequest"],
    tokenAccounting: {
      evaluateRequestBudget: async () => budgetSnapshot(100),
      snapshotFromTokens: (usageTokens: number) => budgetSnapshot(usageTokens),
    } as unknown as AgentRuntimeDependencies["tokenAccounting"],
  });

  const evaluator = createBudgetEvaluator(f.deps, baseInput(), {
    decision: { provider: "routed", model: "routed-model" } as never,
    baseRequest: { provider: "test", model: "test-model", messages: [] } as CanonicalModelRequest,
    maxContextTokens: 8000,
    reservedOutputTokens: 512,
  });
  const snapshot = await evaluator!([user("candidate")], { inputTokens: 500 });

  assert.equal(materialized.length, 1);
  assert.equal(snapshot.tokens, 500);
});
