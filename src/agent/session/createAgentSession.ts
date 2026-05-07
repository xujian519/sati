import { PermissionRuntime } from "../../permission/index.js";
import { SequentialToolScheduler, ToolRuntime } from "../../tool/index.js";
import { AgentLoop } from "../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { InMemoryTranscriptWriter } from "../transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import { TurnRunner } from "../turn/TurnRunner.js";
import { AgentSession } from "./AgentSession.js";

export type CreateAgentSessionOptions = {
  sessionId: string;
  config: AgentRuntimeConfig;
  dependencies: Omit<AgentRuntimeDependencies, "tools"> & {
    tools: Partial<AgentRuntimeDependencies["tools"]> & Pick<AgentRuntimeDependencies["tools"], "registry">;
  };
  transcript?: AgentTranscriptWriter;
};

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const toolRuntime = new ToolRuntime(options.dependencies.tools.registry, new PermissionRuntime());
  const scheduler = options.dependencies.tools.scheduler ?? new SequentialToolScheduler(toolRuntime);
  const dependencies: AgentRuntimeDependencies = {
    ...options.dependencies,
    tools: {
      registry: options.dependencies.tools.registry,
      scheduler,
    },
  };
  const loop = new AgentLoop(options.config, dependencies);
  const transcript = options.transcript ?? new InMemoryTranscriptWriter();
  const turnRunner = new TurnRunner(loop, transcript, undefined, dependencies.now);
  return new AgentSession({
    sessionId: options.sessionId,
    turnRunner,
    uuid: dependencies.uuid,
  });
}
