import { resolve } from "node:path";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import type { AgentRuntimeConfig, CreateAgentSessionOptions } from "../agent/index.js";
import { DefaultContextRuntime, PluginRuntimeExtensionResolver } from "../context/index.js";
import { HookRuntime, PluginRuntime } from "../extension/index.js";
import { LifecycleRuntime } from "../lifecycle/index.js";
import {
  createGateway,
  type Gateway,
  type GatewayCronController,
  type GatewayProjectStorageOptions,
  type GatewaySessionContext,
  type ListSessionsInput,
  type ListSessionsResult,
} from "../gateway/index.js";
import { createModelRuntime, type ModelRuntime } from "../model/index.js";
import { createDefaultPermissionContext } from "../permission/index.js";
import { loadPolitConfig, resolvePolitHome } from "../polit/index.js";
import type { PolitAgentModelSelection } from "../polit/config/types.js";
import type { RouterConfig } from "../router/config/schema.js";
import { listProjectSessions, resumeAgentSession } from "../session/index.js";
import { createBuiltinRegistry } from "../tool/index.js";
import type { PolitDeckToolDefinition, ToolRegistry } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  politHome?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
  /** Tools merged into every per-project ToolRegistry. */
  extraTools?: PolitDeckToolDefinition[];
  /** Per-sessionKey config overrides (cwd / permissionMode). */
  sessionOverrides?: SessionConfigOverrides;
  /** Optional Cron runtime controller exposed through Gateway management methods. */
  cron?: GatewayCronController;
};

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): Gateway {
  const baseEnv = options.env ?? process.env;
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const politHome = options.politHome ?? resolvePolitHome(baseEnv);
  const env = options.politHome ? { ...baseEnv, POLIT_HOME: politHome } : baseEnv;
  const now = () => new Date();
  const registry = new ProjectRuntimeRegistry({
    defaultProjectRoot: projectRoot,
    politHome,
    env,
    permissionMode: options.permissionMode ?? "default",
    now,
    extraTools: options.extraTools,
    sessionOverrides: options.sessionOverrides,
  });
  const defaultRuntime = registry.resolve();

  return createGateway({
    session: {
      create: (context) => registry.createSession(context),
      list: (input) => registry.listSessions(input),
    },
    idleSessionTimeoutMs: (defaultRuntime.snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    now,
    serverInfo: {
      projectKey: projectRoot,
    },
    cron: options.cron,
  });
}

type ProjectRuntimeRegistryOptions = {
  defaultProjectRoot: string;
  politHome: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
  extraTools?: PolitDeckToolDefinition[];
  sessionOverrides?: SessionConfigOverrides;
};

type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPolitConfig>;
  model: ModelRuntime;
  router: RouterRuntime;
  pluginRuntime: PluginRuntime;
  tools: ToolRegistry;
  projectStorage: GatewayProjectStorageOptions;
};

class ProjectRuntimeRegistry {
  private readonly runtimes = new Map<string, ProjectRuntime>();

  constructor(private readonly options: ProjectRuntimeRegistryOptions) {}

  resolve(projectKey?: string): ProjectRuntime {
    const projectRoot = resolve(projectKey ?? this.options.defaultProjectRoot);
    const cached = this.runtimes.get(projectRoot);
    if (cached) {
      return cached;
    }

    const snapshot = loadPolitConfig({ projectRoot, env: this.options.env });
    const model = createModelRuntime(snapshot.config.model);
    const pluginRuntime = new PluginRuntime({
      projectRoot,
      politHome: this.options.politHome,
      builtinPluginsEnabled: snapshot.config.extension.builtinPluginsEnabled,
    });
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: this.options.now,
      customRouterRegistry: pluginRuntime,
      loadSkillPrompt: (extensionId) => pluginRuntime.loadSkillPrompt(extensionId),
    });
    const tools = createBuiltinRegistry();
    for (const tool of this.options.extraTools ?? []) {
      tools.register(tool);
    }
    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      router,
      pluginRuntime,
      tools,
      projectStorage: {
        projectRoot,
        politHome: this.options.politHome,
      },
    };
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  async createSession(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    await runtime.pluginRuntime.refresh();
    const contributions = runtime.pluginRuntime.snapshotContributions();
    const lifecycle = new LifecycleRuntime(new HookRuntime(contributions.hooks));
    const contextRuntime = new DefaultContextRuntime({
      extension: new PluginRuntimeExtensionResolver(runtime.pluginRuntime),
      projectRoot: runtime.projectRoot,
      now: this.options.now,
    });
    const resumed = await resumeAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(runtime, context.sessionKey),
      dependencies: {
        router: runtime.router,
        tools: { registry: runtime.tools },
        context: contextRuntime,
        lifecycle,
        now: this.options.now,
      },
      projectStorage: runtime.projectStorage,
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
      }),
    };
  }
}

function ensureRouterConfig(
  router: RouterConfig | undefined,
  defaultSelection: PolitAgentModelSelection,
): RouterConfig {
  if (router) {
    return router;
  }
  return {
    scenarios: {
      default: { id: defaultSelection.id, provider: defaultSelection.provider, model: defaultSelection.model },
      longContextThreshold: 60_000,
    },
    zeroUsageRetry: { enabled: true, maxAttempts: 5 },
  };
}
