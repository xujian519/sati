import { createAgentSession, type AgentRuntimeConfig } from "../agent/index.js";
import { createGateway, type Gateway } from "../gateway/index.js";
import { createModelRuntime } from "../model/index.js";
import { createDefaultPermissionContext } from "../permission/index.js";
import { loadPolitConfig, resolvePolitHome } from "../polit/index.js";
import { createBuiltinRegistry } from "../tool/index.js";

export type CreateLocalGatewayOptions = {
  projectRoot?: string;
  politHome?: string;
  permissionMode?: AgentRuntimeConfig["permissionMode"];
};

export function createLocalGateway(options: CreateLocalGatewayOptions = {}): Gateway {
  const projectRoot = options.projectRoot ?? process.cwd();
  const politHome = options.politHome ?? resolvePolitHome();
  const snapshot = loadPolitConfig({ projectRoot });
  const modelConfig = snapshot.config.model;
  const agent = snapshot.config.agent;
  const provider = agent.model.provider;
  const model = agent.model.model;
  const permissionMode = options.permissionMode ?? "default";
  const registry = createBuiltinRegistry();
  const now = () => new Date();
  const modelRuntime = createModelRuntime(modelConfig);
  const agentConfig: AgentRuntimeConfig = {
    provider,
    model,
    cwd: projectRoot,
    fallbackProvider: agent.fallbackModel?.provider,
    fallbackModel: agent.fallbackModel?.model,
    permissionMode,
    permissionContext: createDefaultPermissionContext({
      cwd: projectRoot,
      mode: permissionMode,
      canPrompt: false,
      bypassAvailable: true,
    }),
  };

  return createGateway({
    projectStorage: { projectRoot, politHome },
    idleSessionTimeoutMs: (snapshot.config.gateway?.idleSessionTimeoutMinutes ?? 30) * 60_000,
    agent: {
      config: agentConfig,
      dependencies: {
        model: modelRuntime,
        tools: { registry },
        now,
      },
    },
  });
}
