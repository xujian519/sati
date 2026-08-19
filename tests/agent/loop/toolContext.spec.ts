import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type {
  AgentRuntimeDependencies,
  AgentRouterRuntime,
} from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { PermissionContext } from "../../../src/permission/index.js";
import { ToolContextFactory } from "../../../src/agent/loop/toolContext.js";
import { createLifecycleDispatcher } from "../../../src/agent/loop/misc.js";
import type { AgentLoopInput } from "../../../src/agent/protocol/input.js";
import type { RouterDecision } from "../../../src/router/protocol/decision.js";
import type { CanonicalModelRequest } from "../../../src/model/index.js";
import type { PlanFileManager } from "../../../src/tool/builtin/planFile.js";
import type { PlanTodoStateManager } from "../../../src/agent/runtime/PlanTodoState.js";
import type { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import type { SatiPlanTodoStateHandle } from "../../../src/tool/protocol/types.js";

/**
 * ToolContextFactory 行为基线测试（AgentLoop 拆解轮次 3）。
 */

type ConfigOverrides = Partial<Omit<AgentRuntimeConfig, "permissionContext">> & {
  permissionContext?: Partial<PermissionContext>;
};

function makeConfig(overrides: ConfigOverrides = {}): AgentRuntimeConfig {
  const base: AgentRuntimeConfig = {
    provider: "test",
    model: "test-model",
    cwd: "/proj",
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      rules: { allow: [], deny: [], ask: [] },
      cwd: "/proj",
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
    },
  };
  return {
    ...base,
    ...overrides,
    permissionContext: { ...base.permissionContext, ...(overrides.permissionContext ?? {}) },
  };
}

function emptyDecision(): RouterDecision {
  return {
    provider: "test",
    model: "test-model",
    scenarioType: "default",
    isSubagent: false,
    orchestrating: false,
    resolvedFrom: "fallback",
    mutations: {},
  };
}

function makeDeps(overrides: Partial<AgentRuntimeDependencies> = {}): AgentRuntimeDependencies {
  return {
    router: {
      stream: async function* () {},
      decide: async () => emptyDecision(),
      execute: async function* () {},
    },
    tools: {
      scheduler: { executeAll: async () => [] },
      registry: {} as unknown as ToolRegistry,
    },
    ...overrides,
  };
}

function makeInput(overrides: Partial<AgentLoopInput> = {}): AgentLoopInput {
  return {
    sessionId: "/proj::sess-1",
    turnId: "turn-1",
    messages: [],
    ...overrides,
  };
}

function makeFactory(overrides: { config?: ConfigOverrides; deps?: Partial<AgentRuntimeDependencies> } = {}) {
  const config = makeConfig(overrides.config);
  const dependencies = makeDeps(overrides.deps);
  const factory = new ToolContextFactory({
    config,
    dependencies,
    readFileState: new Map(),
    writeSnapshots: new Map(),
    allowedReadFiles: new Set(["/proj/a.md", "/proj/b.md"]),
    now: () => new Date("2026-08-14T00:00:00.000Z"),
    dispatchLifecycle: createLifecycleDispatcher(config, dependencies),
  });
  return { factory, config, dependencies };
}

test("createToolContext：基础字段组装（sessionId/turnId/cwd/env）", () => {
  const { factory } = makeFactory({ config: { runMode: "plan" } });
  const ctx = factory.createToolContext(makeInput());
  assert.equal(ctx.sessionId, "/proj::sess-1");
  assert.equal(ctx.turnId, "turn-1");
  assert.equal(ctx.messageId, "turn-1", "messageId 取 turnId（稳定撤销分组键）");
  assert.equal(ctx.cwd, "/proj");
  assert.equal(ctx.runMode, "plan");
  assert.equal(ctx.permissionMode, "default");
  const env = ctx.env!;
  assert.equal(env.SESSION_ID, "/proj::sess-1");
  assert.equal(env.TURN_ID, "turn-1");
  // WORK_DIR = <cwd>/.sati/work/<safeSessionId>/<safeTurnId>；sessionId
  // "/proj::sess-1" 经 safeWorkPathSegment 得 "proj-sess-1"（连续非法字符
  // 合并为单个 `-`）。分隔符随平台（\ 或 /）。
  assert.match(env.WORK_DIR ?? "", /[\\/]\.sati[\\/]work[\\/]proj-sess-1[\\/]turn-1$/);
  assert.equal(ctx.now!().toISOString(), "2026-08-14T00:00:00.000Z");
});

test("createToolContext：runMode 缺省回退 agent，canPrompt 优先 input", () => {
  const { factory } = makeFactory({ config: { permissionContext: { canPrompt: false } } });
  const base = factory.createToolContext(makeInput());
  assert.equal(base.runMode, "agent");
  assert.equal(base.permissionContext.canPrompt, false);

  const overridden = factory.createToolContext(makeInput({ canPrompt: true }));
  assert.equal(overridden.permissionContext.canPrompt, true, "input.canPrompt 覆盖 config");
});

test("createToolContext：model.stream 适配器转发到 router（isMainAgent=false）", async () => {
  const seen: unknown[] = [];
  const stream = async function* (request: unknown, options: Record<string, unknown>) {
    seen.push({ request, options });
    yield;
  };
  const config = makeConfig();
  const dependencies = makeDeps({
    router: {
      stream: stream as unknown as AgentRouterRuntime["stream"],
      decide: async () => emptyDecision(),
      execute: async function* () {},
    },
  });
  const factory = new ToolContextFactory({
    config,
    dependencies,
    readFileState: new Map(),
    writeSnapshots: new Map(),
    allowedReadFiles: new Set(),
    now: () => new Date(),
    dispatchLifecycle: createLifecycleDispatcher(config, dependencies),
  });
  const ctx = factory.createToolContext(makeInput());
  const iter = ctx.model!.stream({ model: "m" } as unknown as CanonicalModelRequest, undefined);
  await iter[Symbol.asyncIterator]().next();
  assert.equal(seen.length, 1);
  const options = (seen[0] as { options: Record<string, unknown> }).options;
  assert.equal(options.sessionId, "/proj::sess-1");
  assert.equal(options.turnId, "turn-1");
  assert.equal(options.projectPath, "/proj");
  assert.equal(options.isMainAgent, false);
});

test("createToolContext：planFileManager 存在时注入 planDirectoryPath/planDirectory", () => {
  const planDir = "/proj/.sati/plans";
  const { factory } = makeFactory({
    deps: {
      planFileManager: {
        getPlanDirectoryPath: () => planDir,
        resolvePlanFilePath: (filePath: string, _cwd: string) => `/resolved/${filePath}`,
        readPlanFile: (filePath: string, _cwd: string) => `content:${filePath}`,
      } satisfies PlanFileManager,
    },
  });
  const ctx = factory.createToolContext(makeInput());
  assert.equal(ctx.permissionContext.planDirectoryPath, planDir);
  assert.equal(ctx.planDirectory?.path, planDir);
  assert.equal(ctx.planDirectory?.resolve("x.md"), "/resolved/x.md");
});

test("createToolContext：planTodoManager 命中时注入 planTodo", () => {
  const { factory } = makeFactory({
    deps: {
      planTodoManager: {
        forSession: () => ({ pending: 2 }) as unknown as SatiPlanTodoStateHandle,
      } satisfies PlanTodoStateManager,
    },
  });
  const ctx = factory.createToolContext(makeInput());
  assert.deepEqual(ctx.planTodo, { pending: 2 });
});

test("createToolContext：allowedReadFiles 拷贝为数组快照", () => {
  const { factory } = makeFactory();
  const ctx = factory.createToolContext(makeInput());
  assert.deepEqual([...ctx.allowedReadFiles!].sort(), ["/proj/a.md", "/proj/b.md"]);
});

test("buildSubagentForkApi：depth/maxSubagentDepth/定义列表", () => {
  const { factory } = makeFactory({ config: { subagentDepth: 2, maxSubagentDepth: 3 } });
  const api = factory.buildSubagentForkApi(makeInput());
  assert.equal(api.depth, 2);
  assert.equal(api.maxSubagentDepth, 3);
  assert.equal(api.isAllowedDefinition("explore"), true, "内置 explore 定义可识别");
  assert.equal(api.isAllowedDefinition("no-such-type"), false);
  const defs = api.listDefinitions();
  assert.equal(defs.length > 0, true);
  assert.ok(defs.every(d => typeof d.id === "string" && typeof d.description === "string"));
});

test("buildSubagentForkApi：fork 未知子代理类型时抛错", async () => {
  const { factory } = makeFactory();
  const api = factory.buildSubagentForkApi(makeInput());
  await assert.rejects(
    api.fork({
      definitionId: "no-such-type",
      directive: "x",
      subagentId: "sub-1",
      toolCallId: "t1",
    }),
    /Unknown subagent type: no-such-type/,
  );
});

test("createLifecycleDispatcher：未注入 lifecycle 返回空结果", async () => {
  const dispatcher = createLifecycleDispatcher(makeConfig(), makeDeps());
  const result = await dispatcher(makeInput(), "PreModelRequest", {});
  assert.deepEqual(result, {
    effects: [],
    messages: [],
    events: [],
    blockingErrors: [],
    nonBlockingErrors: [],
  });
});

test("createLifecycleDispatcher：注入 lifecycle 时转发参数", async () => {
  const seen: unknown[] = [];
  const dispatcher = createLifecycleDispatcher(makeConfig({ permissionMode: "plan" }), {
    ...makeDeps(),
    lifecycle: {
      dispatch: async (args: unknown) => {
        seen.push(args);
        return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
      },
    } as unknown as NonNullable<AgentRuntimeDependencies["lifecycle"]>,
  });
  const result = await dispatcher(makeInput(), "SubagentStart", { subagentId: "s1" });
  assert.deepEqual(result.blockingErrors, []);
  assert.equal(seen.length, 1);
  const args = seen[0] as {
    event: string;
    baseInput: Record<string, unknown>;
    payload: Record<string, unknown>;
    matchQuery: string;
    env: Record<string, unknown>;
  };
  assert.equal(args.event, "SubagentStart");
  assert.equal(args.baseInput.sessionId, "/proj::sess-1");
  assert.equal(args.baseInput.cwd, "/proj");
  assert.equal(args.baseInput.permissionMode, "plan");
  assert.equal(args.payload.subagentId, "s1");
  assert.equal(args.matchQuery, "SubagentStart");
  assert.equal(args.env.SESSION_ID, "/proj::sess-1");
});

test("ToolContextFactory 实例内子代理上下文：subagentDepth 缺省 0、subagentTimeoutMs 透传", () => {
  const { factory } = makeFactory({ config: { subagentTimeoutMs: 12_000 } });
  const ctx = factory.createToolContext(makeInput());
  assert.equal(ctx.subagentDepth, 0);
  assert.equal(ctx.subagentTimeoutMs, 12_000);
  assert.equal(ctx.subagent!.depth, 0);
  assert.equal(ctx.subagent!.maxSubagentDepth, 1, "maxSubagentDepth 缺省 1");
});
