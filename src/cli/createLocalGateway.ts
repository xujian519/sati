import { appendFileSync, mkdirSync as mkdirSyncFs } from "node:fs";
import { resolve, join as joinPath } from "node:path";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AgentRuntimeConfig, CreateAgentSessionOptions } from "../agent/index.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  ContextOverflowRecovery,
  DefaultContextRuntime,
  MicroCompactionEngine,
  PluginRuntimeExtensionResolver,
  SnipEngine,
  TokenBudgetManager,
  ToolResultBudget,
  createEdgeClawMemoryProviderFromConfig,
} from "../context/index.js";
import { FileHistoryStore } from "../session/filesystem/FileHistoryStore.js";
import type { AgentSubagentTranscriptHooks } from "../agent/runtime/AgentRuntimeDependencies.js";
import { HookRuntime, PluginRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  GatewayElicitationChannel,
  InProcessGateway,
  SessionRouter,
  type Gateway,
  type GatewayCronController,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import {
  GATEWAY_PERMISSION_CALLBACK_NAME,
  createGatewayPermissionHook,
} from "../gateway/permission/createGatewayPermissionHook.js";
import {
  McpRuntime,
  createMcpToolDefinitionsFromRuntime,
  parsePluginMcpServers,
} from "../mcp/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { createDefaultPermissionContext, type PermissionRule } from "../permission/index.js";
import { loadPilotConfig, resolvePilotHome } from "../pilot/index.js";
import { createPilotConfigStoreSync, type PilotConfigStore } from "../pilot/config/PilotConfigStore.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import type { RouterConfig } from "../router/config/schema.js";
import { listProjectSessions, resumeAgentSession } from "../session/index.js";
import { readWebSessionMessages } from "../web/server/readSessionMessages.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import { createBuiltinRegistry } from "../tool/index.js";
import type { PilotDeckToolDefinition, ToolRegistry, PilotDeckElicitationChannel } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
import type { RouterEventBus, RouterEvent } from "../router/protocol/events.js";
import type { EdgeClawMemoryProvider } from "../context/index.js";
import { loadBuiltinPlugins } from "../extension/plugins/builtin/loadBuiltinPlugins.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  pilotHome?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PilotDeckToolDefinition[];
  /** Per-sessionKey config overrides (cwd / permissionMode). */
  sessionOverrides?: SessionConfigOverrides;
  /** Optional Cron runtime controller exposed through Gateway management methods. */
  cron?: GatewayCronController;
  /**
   * Additional directories the agent is allowed to read/write outside of `projectRoot`.
   * Passed to PermissionContext so `pathSafety` accepts paths within these roots.
   */
  additionalWorkingDirectories?: string[];
  /**
   * @internal Testing hook — replaces the production `createModelRuntime`
   * call when present. Tests can return a fake `ModelRuntime` (e.g. a scripted
   * stream) so the rest of the wiring (Router, Tools, Context, AgentLoop) runs
   * end-to-end against a deterministic transport. NOT part of the public API.
   */
  __testModelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  /**
   * When true, `ask_user_question` tool calls are answered automatically
   * (first option selected) instead of waiting for a human. Intended for
   * benchmark / headless runs where no interactive user is present.
   */
  autoElicitation?: boolean;
};

export type CreateLocalGatewayResult = {
  gateway: Gateway;
  configStore: PilotConfigStore;
  registry: ProjectRuntimeRegistry;
  dispose: () => void;
};

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): CreateLocalGatewayResult {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const pilotHome = options.pilotHome ?? resolvePilotHome(baseEnv);
  const env = options.pilotHome ? { ...baseEnv, PILOT_HOME: pilotHome } : baseEnv;
  const now = () => new Date();
  const registry = new ProjectRuntimeRegistry({
    defaultProjectRoot: projectRoot,
    pilotHome,
    env,
    permissionMode: options.permissionMode ?? "default",
    now,
    extraTools: options.extraTools,
    sessionOverrides: options.sessionOverrides,
    additionalWorkingDirectories: options.additionalWorkingDirectories,
    modelFactory: options.__testModelFactory,
    autoElicitation: options.autoElicitation,
  });
  const defaultRuntime = registry.resolve();

  const configStore = createPilotConfigStoreSync({ projectRoot, env });
  const stopWatching = configStore.startWatching();

  configStore.subscribe((event) => {
    const { changeClasses, changedPaths } = event;
    if (changeClasses.length === 0) {
      return;
    }
    if (changeClasses.every((c) => c === "restart-required")) {
      // eslint-disable-next-line no-console
      console.warn("[pilotdeck] Config change requires process restart:", changedPaths.join(", "));
      return;
    }
    // eslint-disable-next-line no-console
    console.log("[pilotdeck] Config reloaded, invalidating runtimes:", changedPaths.join(", "));
    registry.invalidate();
  });

  const router = new SessionRouter({
    createSession: (ctx) => registry.createSession(ctx),
    listSessions: (input) => registry.listSessions(input),
    idleSessionTimeoutMs:
      (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    now,
  });
  const gateway = new InProcessGateway(router, {
    now,
    serverInfo: { mode: "in_process", projectKey: projectRoot },
    cron: options.cron,
    readSessionMessages: (input) =>
      readWebSessionMessages(input, {
        projectRoot: input.projectKey ? input.projectKey : projectRoot,
        pilotHome,
        now,
      }),
    listProjects: () =>
      listWebProjects({ pilotHome, defaultProjectRoot: projectRoot }),
    describeProject: (input) =>
      describeWebProject(input.projectKey, { pilotHome, defaultProjectRoot: projectRoot }),
    async reloadConfig() {
      let changedPaths: string[] = [];
      const unsubscribe = configStore.subscribe((event) => {
        changedPaths = event.changedPaths;
      });
      try {
        await configStore.reload("rpc");
      } finally {
        unsubscribe();
      }
      return { reloaded: true, changedPaths };
    },
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  return {
    gateway,
    configStore,
    registry,
    dispose: stopWatching,
  };
}

type ProjectRuntimeRegistryOptions = {
  defaultProjectRoot: string;
  pilotHome: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  additionalWorkingDirectories?: string[];
  /** @internal Test hook from `CreateLocalGatewayOptions.__testModelFactory`. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
  autoElicitation?: boolean;
};

type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPilotConfig>;
  model: ModelRuntime;
  router: RouterRuntime;
  pluginRuntime: PluginRuntime;
  tools: ToolRegistry;
  projectStorage: GatewayProjectStorageOptions;
  /** Per-project background task runtime (shared across sessions). C5. */
  backgroundTasks: BackgroundTaskRuntime;
  /** Memory provider, undefined when memory is disabled in PilotConfig. */
  memory?: EdgeClawMemoryProvider;
  /**
   * Lazily-started MCP runtime (C1). Built on first session creation by
   * `ensureMcpReady()` because plugin refresh + connect is async.
   */
  mcpRuntime?: McpRuntime;
  /** Tracks the in-flight `ensureMcpReady` promise so concurrent sessions share it. */
  mcpReady?: Promise<void>;
};

class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();
  private gateway?: InProcessGateway;
  /**
   * Per-session live permission rules used when no `sessionOverrides`
   * entry exists. Same array reference is handed to:
   *   - `createDefaultPermissionContext({ rules })` so `PermissionRuntime.decide`
   *     sees current allow/deny entries.
   *   - `createGatewayPermissionHook({ permissionRules })` so the hook can
   *     push session-scoped allow rules on `remember=true` and have the
   *     very next `decide()` call inside this turn see them.
   * Without this fallback, remote-gateway clients (Web UI talking to
   * `pilotdeck server`) wouldn't be able to round-trip permission
   * prompts because they can't reach into the server's `sessionOverrides`
   * map from outside the process.
   */
  private readonly fallbackRuleSets = new Map<
    string,
    { allow: PermissionRule[]; deny: PermissionRule[]; ask: PermissionRule[] }
  >();

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {}

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  private buildRouterEventBus(): RouterEventBus {
    const pilotHome = this.options.pilotHome;
    const eventsPath = joinPath(pilotHome, "router-events.jsonl");
    try { mkdirSyncFs(pilotHome, { recursive: true }); } catch { /* exists */ }
    return {
      emit(event: RouterEvent) {
        try {
          appendFileSync(eventsPath, JSON.stringify(event) + "\n");
        } catch { /* best-effort, never crash the agent loop */ }
      },
    };
  }

  /**
   * Resolve the live permission-rule set for a session. Prefers any
   * explicit `sessionOverrides` entry (used by `always-on` to inject a
   * pre-populated allow list); otherwise lazily mints a per-session
   * fallback so the gateway permission hook always has a live array to
   * push `remember=true` grants into.
   */
  private getLiveRuleSet(sessionKey: string): {
    allow: PermissionRule[];
    deny: PermissionRule[];
    ask: PermissionRule[];
  } {
    const explicit = this.options.sessionOverrides?.get(sessionKey)?.permissionRules;
    if (explicit) {
      return {
        allow: explicit.allow ?? [],
        deny: explicit.deny ?? [],
        ask: explicit.ask ?? [],
      };
    }
    let auto = this.fallbackRuleSets.get(sessionKey);
    if (!auto) {
      auto = { allow: [], deny: [], ask: [] };
      this.fallbackRuleSets.set(sessionKey, auto);
    }
    return auto;
  }

  /**
   * Drop cached runtimes so the next `resolve()` call rebuilds from
   * a fresh `loadPilotConfig()` snapshot. Gracefully shuts down any
   * active MCP connections before discarding the entry.
   */
  invalidate(projectRoot?: string): void {
    if (projectRoot) {
      const runtime = this.runtimes.get(projectRoot);
      if (runtime?.mcpRuntime) {
        runtime.mcpRuntime.stop().catch(() => {});
      }
      this.runtimes.delete(projectRoot);
    } else {
      for (const [, runtime] of this.runtimes) {
        if (runtime.mcpRuntime) {
          runtime.mcpRuntime.stop().catch(() => {});
        }
      }
      this.runtimes.clear();
    }
  }

  resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolve(projectKey ?? this.options.defaultProjectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPilotConfig({ projectRoot, env: this.options.env });
    const model = this.options.modelFactory
      ? this.options.modelFactory(snapshot)
      : createModelRuntime(snapshot.config.model);
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      pilotHome: this.options.pilotHome,
      builtinPlugins: loadBuiltinPlugins(),
      builtinPluginsEnabled: snapshot.config.extension.builtinPluginsEnabled,
    });
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: this.options.now,
      customRouterRegistry: pluginRuntime,
      loadSkillPrompt: (extensionId) => pluginRuntime.loadSkillPrompt(extensionId),
      events: this.buildRouterEventBus(),
    });
    const backgroundTasks = new BackgroundTaskRuntime({ now: this.options.now });
    const tools = createBuiltinRegistry({ backgroundTasks: { runtime: backgroundTasks } });
    for (const tool of this.options.extraTools ?? []) {
      tools.register(tool);
    }

    const memory = createEdgeClawMemoryProviderFromConfig({
      config: snapshot.config.memory,
      projectRoot,
      now: this.options.now,
    });

    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      router,
      pluginRuntime,
      tools,
      backgroundTasks,
      memory: memory?.provider,
      projectStorage: {
        projectRoot,
        pilotHome: this.options.pilotHome,
      },
    };
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  /**
   * Lazily start the MCP runtime for this project. Idempotent — concurrent
   * callers share a single in-flight promise. Errors are swallowed (logged
   * to stderr) so a misbehaving MCP server can't take the gateway down.
   */
  private ensureMcpReady(runtime: ProjectRuntime): Promise<void> {
    if (runtime.mcpReady) return runtime.mcpReady;
    runtime.mcpReady = (async () => {
      try {
        const rawServers = runtime.pluginRuntime.mcpServers();
        const { servers } = parsePluginMcpServers(rawServers);
        if (servers.length === 0) return;
        const mcp = new McpRuntime(servers);
        runtime.mcpRuntime = mcp;
        await mcp.start();
        const defs = await createMcpToolDefinitionsFromRuntime(mcp);
        for (const def of defs) {
          if (!runtime.tools.has(def.name)) runtime.tools.register(def);
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(
          `[pilotdeck] MCP runtime startup partial-failed for project ${runtime.projectRoot}:`,
          (err as Error).message,
        );
      }
    })();
    return runtime.mcpReady;
  }

  async createSession(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    await runtime.pluginRuntime.refresh();
    await this.ensureMcpReady(runtime);
    const contributions = runtime.pluginRuntime.snapshotContributions();

    // Inject the gateway's interactive permission hook so the agent's
    // PermissionRequest lifecycle is round-tripped through whichever
    // client is streaming this session (Web UI, TUI, etc.) instead of
    // returning `permission_required` errors. The hook mutates the
    // session's live `permissionRules.allow` array on `remember=true`,
    // so a subsequent tool call inside the same turn bypasses the ask
    // path without waiting for the next turn.
    //
    // We register unconditionally whenever a gateway is wired up. If no
    // client is actively streaming, `gw.emitForSession()` returns false
    // and the hook auto-denies — better than silently hanging.
    const gw = this.gateway;
    const liveRuleSet = this.getLiveRuleSet(context.sessionKey);
    const hookSettings: typeof contributions.hooks = gw
      ? {
          ...contributions.hooks,
          PermissionRequest: [
            ...(contributions.hooks.PermissionRequest ?? []),
            {
              hooks: [
                { type: "callback", name: GATEWAY_PERMISSION_CALLBACK_NAME },
              ],
            },
          ],
        }
      : contributions.hooks;
    const hookRuntime = new HookRuntime(hookSettings);
    if (gw) {
      hookRuntime.getCallbackExecutor().register(
        GATEWAY_PERMISSION_CALLBACK_NAME,
        createGatewayPermissionHook({
          sessionKey: context.sessionKey,
          bus: gw.getPermissionBus(),
          emit: (event) => gw.emitForSession(context.sessionKey, event),
          permissionRules: liveRuleSet.allow,
        }),
      );
    }
    const lifecycle = new LifecycleRuntime(hookRuntime);
    const extension = new PluginRuntimeExtensionResolver(runtime.pluginRuntime);
    const projectRoot = runtime.projectRoot;
    const memoryResolver = runtime.memory;
    const now = this.options.now;

    const resumed = await resumeAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(runtime, context.sessionKey),
      dependencies: {
        router: runtime.router,
        tools: { registry: runtime.tools },
        // The real context runtime is constructed inside
        // `extendDependencies` once we know the per-session
        // `toolResultsDir` for ToolResultBudget. Leave it undefined here
        // so the per-session wire (with budget + compaction engines) is
        // the only one in scope.
        lifecycle,
        now: this.options.now,
      },
      projectStorage: runtime.projectStorage,
      extendDependencies: (storage) => {
        const toolResultBudget = new ToolResultBudget({ toolResultsDir: storage.toolResultsDir });
        const tokenBudget = new TokenBudgetManager();
        const compactionEngine = new CompactionEngine({
          model: {
            stream: (request, signal) =>
              runtime.router.stream(request, {
                sessionId: context.sessionKey,
                turnId: "compact",
                abortSignal: signal,
                isMainAgent: false,
              }),
          },
          tokenBudget,
          lifecycle: {
            async dispatch(input) {
              await lifecycle.dispatch({
                event: input.event,
                baseInput: {
                  sessionId: context.sessionKey,
                  transcriptPath: "",
                  cwd: projectRoot,
                  permissionMode: "default",
                },
                payload: input.payload,
                matchQuery: input.event,
              });
            },
          },
          provider: runtime.snapshot.config.agent.model.provider,
          model_: runtime.snapshot.config.agent.model.model,
          now,
        });
        const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
        const microcompactEngine = new CachedMicroCompactionEngine({ enabled: false });
        const microCompaction = new MicroCompactionEngine();
        const snipEngine = new SnipEngine();
        const overflowRecovery = new ContextOverflowRecovery();
        const caps = runtime.model.getCapabilities(
          runtime.snapshot.config.agent.model.provider,
          runtime.snapshot.config.agent.model.model,
        );
        const contextRuntime = new DefaultContextRuntime({
          extension,
          projectRoot,
          memoryResolver,
          toolResultBudget,
          tokenBudget,
          compactionEngine,
          autoCompactionPolicy,
          microcompactEngine,
          microCompaction,
          snipEngine,
          overflowRecovery,
          maxContextTokens: caps.maxContextTokens,
          now,
        });
        const fileHistory = new FileHistoryStore({
          backupDir: storage.fileHistoryDir,
          now: this.options.now,
        });
        const gw = this.gateway;
        const elicitation = this.options.autoElicitation
          ? createAutoElicitationChannel()
          : gw
            ? new GatewayElicitationChannel({
                sessionKey: context.sessionKey,
                bus: gw.getElicitationBus(),
                emit: (event) => gw.emitForSession(context.sessionKey, event),
              })
            : undefined;
        const subagentTranscript: AgentSubagentTranscriptHooks = {
          recordSubagentStarted: (args) =>
            storage.transcript.recordSubagentStarted(args.sessionId, args.turnId, {
              subagentId: args.subagentId,
              subagentType: args.subagentType,
              prompt: args.prompt,
              transcriptRelativePath: args.transcriptRelativePath,
              subagentSessionId: args.subagentSessionId,
            }),
          recordSubagentCompleted: (args) =>
            storage.transcript.recordSubagentCompleted(args.sessionId, args.turnId, {
              subagentId: args.subagentId,
              subagentType: args.subagentType,
              summary: args.summary,
              usage: args.usage,
              turns: args.turns,
              durationMs: args.durationMs,
              errored: args.errored,
            }),
          subagentTranscriptResolver: (subagentId) => {
            const handle = storage.transcript.forSubagent(subagentId, this.options.now);
            return {
              recordAcceptedInput: (sessionId, turnId, messages) =>
                handle.writer.recordAcceptedInput(sessionId, turnId, messages),
              recordDurableMessage: (sessionId, turnId, message) =>
                handle.writer.recordDurableMessage(sessionId, turnId, message),
              transcriptRelativePath: storage.transcript.relativeSubagentPath(subagentId),
            };
          },
        };
        return {
          context: contextRuntime,
          fileHistory,
          subagentTranscript,
          elicitation,
        };
      },
    });
    return resumed.session;
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    const runtime = this.resolve(input.projectKey);
    const offset = input.cursor ? Number.parseInt(input.cursor, 10) : 0;
    const safeOffset = Number.isFinite(offset) ? offset : 0;
    const sessions = await listProjectSessions({
      ...runtime.projectStorage,
      limit: input.limit,
      offset: safeOffset,
    });
    const nextOffset = safeOffset + sessions.length;
    return {
      sessions,
      nextCursor: input.limit && sessions.length === input.limit ? String(nextOffset) : undefined,
    };
  }

  private createAgentConfig(
    runtime: ProjectRuntime,
    sessionKey: string,
  ): CreateAgentSessionOptions["config"] {
    const agent = runtime.snapshot.config.agent;
    const override = this.options.sessionOverrides?.get(sessionKey);
    const permissionMode = override?.permissionMode ?? this.options.permissionMode;
    const cwd = override?.cwd ?? runtime.projectRoot;
    // Hand `PermissionContext` the same live rule-set reference the
    // gateway permission hook owns (see `getLiveRuleSet`). With this
    // shared reference, an "allow + remember" decision pushed by the
    // hook is visible to `PermissionRuntime.decide` on the very next
    // tool call inside the same turn — no roundtrip back to the client
    // needed, even when the client lives in a different process.
    const liveRuleSet = this.getLiveRuleSet(sessionKey);
    return {
      provider: agent.model.provider,
      model: agent.model.model,
      cwd,
      permissionMode,
      permissionContext: createDefaultPermissionContext({
        cwd,
        mode: permissionMode,
        canPrompt: override?.canPrompt ?? false,
        bypassAvailable: override?.bypassAvailable ?? true,
        additionalWorkingDirectories: this.options.additionalWorkingDirectories,
        rules: {
          allow: liveRuleSet.allow,
          deny: liveRuleSet.deny,
          ask: liveRuleSet.ask,
        },
      }),
    };
  }
}

function createAutoElicitationChannel(): PilotDeckElicitationChannel {
  return {
    async askUser(request) {
      const answers: Record<string, string | string[]> = {};
      for (const q of request.questions) {
        if (q.options.length > 0) {
          answers[q.question] = q.multiSelect
            ? [q.options[0].label]
            : q.options[0].label;
        } else {
          answers[q.question] = "yes";
        }
      }
      return { type: "answered", answers };
    },
  };
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  const defaultRef = { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model };
  if (router) {
    return {
      ...router,
      fallback: router.fallback ?? { default: [defaultRef] },
      stats: router.stats ?? { enabled: true },
    };
  }
  return {
    scenarios: { default: defaultRef },
    fallback: { default: [defaultRef] },
    zeroUsageRetry: { enabled: true, maxAttempts: 2 },
    stats: { enabled: true },
  };
}
