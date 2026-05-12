import { resolve } from "node:path";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AgentRuntimeConfig, CreateAgentSessionOptions } from "../agent/index.js";
import {
  AutoCompactionPolicy,
  CachedMicroCompactionEngine,
  CompactionEngine,
  DefaultContextRuntime,
  PluginRuntimeExtensionResolver,
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
import { createDefaultPermissionContext } from "../permission/index.js";
import { loadPilotConfig, resolvePilotHome } from "../pilot/index.js";
import type { PilotAgentModelSelection, PilotConfigSnapshot } from "../pilot/config/types.js";
import type { RouterConfig } from "../router/config/schema.js";
import { listProjectSessions, resumeAgentSession } from "../session/index.js";
import { readWebSessionMessages } from "../web/server/readSessionMessages.js";
import { describeWebProject, listWebProjects } from "../web/server/listProjects.js";
import { BackgroundTaskRuntime } from "../task/runtime/BackgroundTaskRuntime.js";
import { createBuiltinRegistry } from "../tool/index.js";
import type { PilotDeckToolDefinition, ToolRegistry } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";
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
   * @internal Testing hook — replaces the production `createModelRuntime`
   * call when present. Tests can return a fake `ModelRuntime` (e.g. a scripted
   * stream) so the rest of the wiring (Router, Tools, Context, AgentLoop) runs
   * end-to-end against a deterministic transport. NOT part of the public API.
   */
  __testModelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
};

export type LocalGatewayRouterStatsRecord = {
  sessionId: string;
  scenarioType: string;
  resolvedFrom: string;
  provider: string;
  model: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
  };
  startedAt: string;
  endedAt: string;
};

export type LocalGatewayRouterStatsByProject = Map<
  string,
  {
    aggregate: {
      totalRequests: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      perScenario: Record<string, number>;
      perModel: Record<string, number>;
    };
    records: LocalGatewayRouterStatsRecord[];
  }
>;

const __gatewayRouterStatsAccessors = new WeakMap<
  Gateway,
  () => LocalGatewayRouterStatsByProject
>();

/**
 * Side-channel accessor for router stats produced by RouterRuntime
 * instances spun up inside `createLocalGateway`. We deliberately keep
 * this off the `Gateway` interface so the protocol stays minimal — Web
 * UI consumers (ui/server/pilotdeck-bridge.js) call this directly.
 */
export function getLocalGatewayRouterStats(
  gateway: Gateway,
): LocalGatewayRouterStatsByProject | undefined {
  return __gatewayRouterStatsAccessors.get(gateway)?.();
}

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): Gateway {
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
    modelFactory: options.__testModelFactory,
  });
  const defaultRuntime = registry.resolve();
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
  });
  // Hand the gateway back to the registry so per-session creation can
  // build a `GatewayElicitationChannel` against this gateway's bus +
  // emit-sink (B1).
  registry.setGateway(gateway);
  __gatewayRouterStatsAccessors.set(gateway, () =>
    registry.snapshotAllRouterStats(),
  );
  return gateway;
}

type ProjectRuntimeRegistryOptions = {
  defaultProjectRoot: string;
  pilotHome: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: PilotDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
  /** @internal Test hook from `CreateLocalGatewayOptions.__testModelFactory`. */
  modelFactory?: (snapshot: PilotConfigSnapshot) => ModelRuntime;
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

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {}

  setGateway(gateway: InProcessGateway): void {
    this.gateway = gateway;
  }

  /**
   * Snapshot every per-project RouterRuntime's TokenStatsCollector for
   * the Web UI Dashboard tab. Keyed by canonical project root.
   */
  snapshotAllRouterStats(): LocalGatewayRouterStatsByProject {
    const out: LocalGatewayRouterStatsByProject = new Map();
    for (const [projectRoot, runtime] of this.runtimes.entries()) {
      out.set(projectRoot, {
        aggregate: runtime.router.stats.snapshot(),
        records: runtime.router.stats.recent(1000),
      });
    }
    return out;
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
    // PermissionRequest lifecycle is round-tripped through the Web UI
    // instead of returning `permission_required` errors. The hook
    // mutates the session's live `permissionRules.allow` array on
    // `remember=true`, so a subsequent tool call inside the same turn
    // bypasses the ask path without waiting for the next turn's
    // SessionConfigOverrides sync.
    const gw = this.gateway;
    const sessionOverride = this.options.sessionOverrides?.get(context.sessionKey);
    const liveAllowRules = sessionOverride?.permissionRules?.allow;
    const hookSettings: typeof contributions.hooks = gw && liveAllowRules
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
    if (gw && liveAllowRules) {
      hookRuntime.getCallbackExecutor().register(
        GATEWAY_PERMISSION_CALLBACK_NAME,
        createGatewayPermissionHook({
          sessionKey: context.sessionKey,
          bus: gw.getPermissionBus(),
          emit: (event) => gw.emitForSession(context.sessionKey, event),
          permissionRules: liveAllowRules,
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
        // A2 / A5 — provider-aware token budget + compaction engines.
        // Construction-only here; AgentLoop's reactive compaction loop
        // consumes them via DefaultContextRuntime in a follow-up.
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
          provider: runtime.snapshot.config.agent.model.provider,
          model_: runtime.snapshot.config.agent.model.model,
          now,
        });
        const autoCompactionPolicy = new AutoCompactionPolicy({ tokenBudget });
        // A4 — cached microcompact (Anthropic-only). Default disabled —
        // upstream PilotConfig flag flips this on once the schema lands.
        const microcompactEngine = new CachedMicroCompactionEngine({ enabled: false });
        const contextRuntime = new DefaultContextRuntime({
          extension,
          projectRoot,
          memoryResolver,
          toolResultBudget,
          tokenBudget,
          compactionEngine,
          autoCompactionPolicy,
          microcompactEngine,
          now,
        });
        const fileHistory = new FileHistoryStore({
          backupDir: storage.fileHistoryDir,
          now: this.options.now,
        });
        const gw = this.gateway;
        const elicitation = gw
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
        rules: override?.permissionRules
          ? {
              allow: override.permissionRules.allow ?? [],
              deny: override.permissionRules.deny ?? [],
              ask: override.permissionRules.ask ?? [],
            }
          : undefined,
      }),
    };
  }
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PilotAgentModelSelection,
): RouterConfig {
  if (router) {
    // Make sure stats collection is on so the Web UI Dashboard tab can
    // render router activity. Users can opt out via PilotDeck config.
    return {
      ...router,
      stats: router.stats ?? { enabled: true },
    };
  }
  return {
    scenarios: {
      default: { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model },
    },
    zeroUsageRetry: { enabled: true, maxAttempts: 5 },
    stats: { enabled: true },
  };
}
