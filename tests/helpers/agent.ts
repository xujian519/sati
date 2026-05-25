import type { CanonicalModelEvent, CanonicalModelRequest, CanonicalUsage } from "../../src/model/index.js";
import {
  createDefaultPermissionContext,
  type PermissionMode,
} from "../../src/permission/index.js";
import {
  ToolRegistry,
  ToolRuntime,
  SequentialToolScheduler,
  type PilotDeckToolAuditRecorder,
  type PilotDeckToolDefinition,
} from "../../src/tool/index.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import { AgentLoop, TurnRunner } from "../../src/agent/index.js";
import { InMemoryTranscriptWriter } from "../../src/session/index.js";
import type {
  AgentRouterRuntime,
  AgentRuntimeConfig,
  AgentRuntimeDependencies,
} from "../../src/agent/index.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import type { RouterDecision, RouterDecisionInput, RouterExecuteContext } from "../../src/router/index.js";

export class ScriptedAgentModel {
  readonly requests: CanonicalModelRequest[] = [];
  readonly signals: Array<AbortSignal | undefined> = [];

  constructor(private readonly scripts: CanonicalModelEvent[][]) {}

  async *stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    this.signals.push(signal);
    const script = this.scripts.shift() ?? [
      { type: "message_start", role: "assistant" },
      { type: "message_end", finishReason: "stop" },
    ];
    for (const event of script) {
      if (signal?.aborted) {
        return;
      }
      yield event;
    }
  }
}

/**
 * Minimal router-like object the agent loop accepts. Tests use this to script
 * model events and optionally swap models on subsequent turns (mimicking the
 * router's fallback chain semantics).
 */
export class ScriptedAgentRouter implements AgentRouterRuntime {
  readonly model: ScriptedAgentModel;
  readonly fallbackProvider?: string;
  readonly fallbackModel?: string;
  /** Override provider/model returned by `decide()`. Useful for testing post-routing compaction. */
  decidedProvider?: string;
  decidedModel?: string;
  private fallbackArmed = false;
  readonly observedUsage: Array<{ sessionId: string; usage: CanonicalUsage | undefined }> = [];
  readonly decisions: RouterDecision[] = [];

  constructor(
    scripts: CanonicalModelEvent[][],
    options: { fallbackProvider?: string; fallbackModel?: string } = {},
  ) {
    this.model = new ScriptedAgentModel(scripts);
    this.fallbackProvider = options.fallbackProvider;
    this.fallbackModel = options.fallbackModel;
  }

  async decide(input: RouterDecisionInput): Promise<RouterDecision> {
    const decision: RouterDecision = {
      provider: this.decidedProvider ?? input.request.provider,
      model: this.decidedModel ?? input.request.model,
      scenarioType: "default",
      isSubagent: !input.isMainAgent,
      orchestrating: false,
      resolvedFrom: "explicit",
      mutations: {},
    };
    this.decisions.push(decision);
    return decision;
  }

  async *execute(
    _decision: RouterDecision,
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext,
  ): AsyncIterable<CanonicalModelEvent> {
    const attempts: CanonicalModelRequest[] = [request];
    if (this.fallbackModel) {
      attempts.push({
        ...request,
        provider: this.fallbackProvider ?? request.provider,
        model: this.fallbackModel,
      });
    }
    let lastBuffered: CanonicalModelEvent[] = [];
    let lastError: { provider: string; protocol: string; code: string; message: string; retryable: boolean } | undefined;
    for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex += 1) {
      if (ctx.abortSignal?.aborted) {
        return;
      }
      const buffered: CanonicalModelEvent[] = [];
      let attemptError: typeof lastError;
      for await (const event of this.model.stream(attempts[attemptIndex], ctx.abortSignal)) {
        buffered.push(event);
        if (event.type === "error") {
          attemptError = event.error;
        }
      }
      lastBuffered = buffered;
      if (!attemptError) {
        for (const event of buffered) {
          yield event;
        }
        return;
      }
      lastError = attemptError;
      this.fallbackArmed = attemptIndex >= 0;
      if (!attemptError.retryable) {
        for (const event of buffered) {
          yield event;
        }
        return;
      }
    }
    for (const event of lastBuffered) {
      yield event;
    }
    void lastError;
  }

  async *stream(
    request: CanonicalModelRequest,
    ctx: RouterExecuteContext & { sessionId: string; isMainAgent: boolean; previousTier?: string },
  ): AsyncIterable<CanonicalModelEvent> {
    const decision = await this.decide({
      request,
      sessionId: ctx.sessionId,
      isMainAgent: ctx.isMainAgent,
      metadata: ctx.previousTier ? { previousTier: ctx.previousTier } : undefined,
    });
    yield* this.execute(decision, request, ctx);
  }

  observeUsage(sessionId: string, usage: CanonicalUsage | undefined): void {
    this.observedUsage.push({ sessionId, usage });
  }

  invalidateSticky(_sessionId: string) {
    return { previousTier: undefined, orchestrating: false };
  }
}

export function createAgentLoopFixture(options: {
  scripts: CanonicalModelEvent[][];
  tools?: PilotDeckToolDefinition[];
  permissionMode?: PermissionMode;
  canPrompt?: boolean;
  auditRecorder?: PilotDeckToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  config?: Partial<AgentRuntimeConfig> & { fallbackProvider?: string; fallbackModel?: string };
}): {
  model: ScriptedAgentModel;
  router: ScriptedAgentRouter;
  registry: ToolRegistry;
  loop: AgentLoop;
  transcript: InMemoryTranscriptWriter;
  turnRunner: TurnRunner;
  config: AgentRuntimeConfig;
  dependencies: AgentRuntimeDependencies;
} {
  const fallbackProvider = options.config?.fallbackProvider;
  const fallbackModel = options.config?.fallbackModel;
  const router = new ScriptedAgentRouter(options.scripts, { fallbackProvider, fallbackModel });
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) {
    registry.register(tool);
  }
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime, options.lifecycle);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const permissionMode = options.permissionMode ?? "default";
  const cwd = process.cwd();
  const baseConfig: Partial<AgentRuntimeConfig> = { ...options.config };
  delete (baseConfig as Record<string, unknown>).fallbackProvider;
  delete (baseConfig as Record<string, unknown>).fallbackModel;
  const config: AgentRuntimeConfig = {
    provider: "test-provider",
    model: "test-model",
    cwd,
    permissionMode,
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: permissionMode,
      canPrompt: options.canPrompt ?? false,
    }),
    ...baseConfig,
  };
  const dependencies: AgentRuntimeDependencies = {
    router,
    tools: { registry, scheduler },
    auditRecorder: options.auditRecorder,
    lifecycle: options.lifecycle,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    uuid: () => "generated-id",
  };
  const loop = new AgentLoop(config, dependencies);
  const transcript = new InMemoryTranscriptWriter();
  const turnRunner = new TurnRunner(
    loop,
    transcript,
    undefined,
    dependencies.now,
    dependencies.lifecycle,
    { cwd: config.cwd, transcriptPath: "" },
  );
  return { model: router.model, router, registry, loop, transcript, turnRunner, config, dependencies };
}

export async function collectAsyncGenerator<T, R>(generator: AsyncGenerator<T, R, unknown>): Promise<{
  values: T[];
  result: R;
}> {
  const values: T[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) {
      return { values, result: next.value };
    }
    values.push(next.value);
  }
}
