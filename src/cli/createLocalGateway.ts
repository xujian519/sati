import { resolve } from "node:path";
import { createAgentSession, type AgentRuntimeConfig, type CreateAgentSessionOptions } from "../agent/index.js";
import {
  createGateway,
  type Gateway,
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
import { listProjectSessions } from "../session/index.js";
import { createBuiltinRegistry } from "../tool/index.js";
import type { ToolRegistry } from "../tool/index.js";
import { createRouterRuntime, type RouterRuntime } from "../router/index.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  politHome?: string;
  env?: Record<string, string | undefined>;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
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
  });
}

type ProjectRuntimeRegistryOptions = {
  defaultProjectRoot: string;
  politHome: string;
  env: Record<string, string | undefined>;
  permissionMode: AgentRuntimeConfig["permissionMode"];
  now: () => Date;
};

type ProjectRuntime = {
  projectRoot: string;
  snapshot: ReturnType<typeof loadPolitConfig>;
  model: ModelRuntime;
  router: RouterRuntime;
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
    const routerConfig = ensureRouterConfig(snapshot.config.router, snapshot.config.agent.model);
    const router = createRouterRuntime(routerConfig, {
      modelRuntime: model,
      now: this.options.now,
    });
    const runtime: ProjectRuntime = {
      projectRoot,
      snapshot,
      model,
      router,
      tools: createBuiltinRegistry(),
      projectStorage: {
        projectRoot,
        politHome: this.options.politHome,
      },
    };
    this.runtimes.set(projectRoot, runtime);
    return runtime;
  }

  createSession(context: GatewaySessionContext) {
    const runtime = this.resolve(context.projectKey);
    return createAgentSession({
      sessionId: context.sessionKey,
      config: this.createAgentConfig(runtime),
      dependencies: {
        router: runtime.router,
        tools: { registry: runtime.tools },
        now: this.options.now,
      },
      projectStorage: runtime.projectStorage,
    });
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

  private createAgentConfig(runtime: ProjectRuntime): CreateAgentSessionOptions["config"] {
    const agent = runtime.snapshot.config.agent;
    const permissionMode = this.options.permissionMode;
    return {
      provider: agent.model.provider,
      model: agent.model.model,
      cwd: runtime.projectRoot,
      permissionMode,
      permissionContext: createDefaultPermissionContext({
        cwd: runtime.projectRoot,
        mode: permissionMode,
        canPrompt: false,
        bypassAvailable: true,
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
