import { PermissionRuntime } from "../../permission/index.js";
import { SequentialToolScheduler, ToolRuntime } from "../../tool/index.js";
import { AgentLoop } from "../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { InMemoryTranscriptWriter } from "../transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import { TurnRunner } from "../turn/TurnRunner.js";
import { AgentSession } from "./AgentSession.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "./AgentSessionStorage.js";

export type CreateAgentSessionOptions = {
  sessionId: string;
  config: AgentRuntimeConfig;
  dependencies: Omit<AgentRuntimeDependencies, "tools"> & {
    tools: Partial<AgentRuntimeDependencies["tools"]> & Pick<AgentRuntimeDependencies["tools"], "registry">;
  };
  transcript?: AgentTranscriptWriter;
  projectStorage?: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  initialState?: AgentSessionStateShape;
  replayEvents?: AgentEvent[];
};

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  return createAgentSessionWithStorage(options).session;
}

export function createAgentSessionWithStorage(options: CreateAgentSessionOptions): {
  session: AgentSession;
  storage?: AgentProjectSessionStorage;
} {
  const toolRuntime = new ToolRuntime(options.dependencies.tools.registry, new PermissionRuntime(), options.dependencies.lifecycle);
  const scheduler = options.dependencies.tools.scheduler ?? new SequentialToolScheduler(toolRuntime);
  const dependencies: AgentRuntimeDependencies = {
    ...options.dependencies,
    tools: {
      registry: options.dependencies.tools.registry,
      scheduler,
    },
  };
  const loop = new AgentLoop(options.config, dependencies);
  const storage = options.projectStorage
    ? createAgentProjectSessionStorage({
        ...options.projectStorage,
        sessionId: options.sessionId,
        now: dependencies.now,
      })
    : undefined;
  const transcript = options.transcript ?? storage?.transcript ?? new InMemoryTranscriptWriter();
  const turnRunner = new TurnRunner(loop, transcript, undefined, dependencies.now, dependencies.lifecycle);
  return {
    session: new AgentSession({
      sessionId: options.sessionId,
      turnRunner,
      uuid: dependencies.uuid,
      initialState: options.initialState,
      replayEvents: options.replayEvents,
      lifecycle: dependencies.lifecycle,
    }),
    storage,
  };
}
