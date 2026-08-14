import { PermissionRuntime } from "../../permission/index.js";
import { ConcurrentToolScheduler, ToolRuntime } from "../../tool/index.js";
import { AgentLoop, type AgentLoopSeedState } from "../loop/AgentLoop.js";
import type { AgentRuntimeConfig } from "../runtime/AgentRuntimeConfig.js";
import type { AgentRuntimeDependencies } from "../runtime/AgentRuntimeDependencies.js";
import { InMemoryTranscriptWriter } from "../../session/transcript/InMemoryTranscriptWriter.js";
import type { AgentTranscriptWriter } from "../../session/transcript/TranscriptWriter.js";
import { SessionMetadataStore } from "../../session/metadata/SessionMetadataStore.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import { TurnRunner } from "../turn/TurnRunner.js";
import type { PatentOutputGate } from "../../patent/index.js";
import { createAgentEventBuffer, type AgentEvent } from "../protocol/events.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import {
  createAgentProjectSessionStorage,
  type AgentProjectSessionStorage,
  type AgentProjectSessionStorageOptions,
} from "../../session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../session/transcript/TranscriptReader.js";
import { projectMessagesFromTranscript } from "../../session/transcript/TranscriptReplay.js";
import { JsonlTranscriptWriter } from "../../session/transcript/JsonlTranscriptWriter.js";
import { createDefaultToolGuardRegistry } from "./defaultToolGuards.js";
import { AgentSession } from "./AgentSession.js";

export type CreateAgentSessionOptions = {
  sessionId: string;
  config: AgentRuntimeConfig;
  dependencies: Omit<AgentRuntimeDependencies, "tools"> & {
    tools: Partial<AgentRuntimeDependencies["tools"]> & Pick<AgentRuntimeDependencies["tools"], "registry">;
  };
  transcript?: AgentTranscriptWriter;
  storage?: AgentProjectSessionStorage;
  projectStorage?: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
  initialState?: AgentSessionStateShape;
  seedState?: AgentLoopSeedState;
  replayEvents?: AgentEvent[];
  sessionTitleGenerator?: SessionTitleGenerator;
  initialMetadata?: SessionMetadataValue;
  /** 专利输出门禁（可选）：在消息入库前拦截，命中审批词时挂起等待人工审批。 */
  outputGate?: PatentOutputGate;
  /** Whether Agent-created or modified workspace files should become message artifacts. */
  collectFileArtifacts?: boolean;
};

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  return createAgentSessionWithStorage(options).session;
}

export function createAgentSessionWithStorage(options: CreateAgentSessionOptions): {
  session: AgentSession;
  storage?: AgentProjectSessionStorage;
} {
  const eventBuf = options.dependencies.drainEvents ? undefined : createAgentEventBuffer();
  const emitter = options.dependencies.eventEmitter ?? eventBuf?.emitter;
  const toolRuntime = new ToolRuntime(
    options.dependencies.tools.registry,
    new PermissionRuntime({ guards: createDefaultToolGuardRegistry() }),
    options.dependencies.lifecycle,
    emitter,
  );
  const scheduler =
    options.dependencies.tools.scheduler ??
    new ConcurrentToolScheduler(toolRuntime, options.dependencies.tools.registry);
  const dependencies: AgentRuntimeDependencies = {
    ...options.dependencies,
    tools: {
      registry: options.dependencies.tools.registry,
      scheduler,
    },
    eventEmitter: emitter,
    drainEvents: options.dependencies.drainEvents ?? eventBuf?.drain,
  };
  const loop = new AgentLoop(options.config, dependencies, options.seedState);
  const storage =
    options.storage ??
    (options.projectStorage
      ? createAgentProjectSessionStorage({
          ...options.projectStorage,
          sessionId: options.sessionId,
          now: dependencies.now,
        })
      : undefined);
  const transcript = options.transcript ?? storage?.transcript ?? new InMemoryTranscriptWriter();
  const metadataStore = new SessionMetadataStore({
    transcript,
    sessionId: options.sessionId,
    now: dependencies.now,
  });
  if (options.initialMetadata) {
    metadataStore.restoreFromReplay(options.initialMetadata);
  }
  const runtimeContext = {
    cwd: options.config.cwd,
    transcriptPath: storage?.transcriptPath ?? "",
    collectFileArtifacts: options.collectFileArtifacts ?? true,
  };
  const turnRunner = new TurnRunner(
    loop,
    transcript,
    undefined,
    dependencies.now,
    dependencies.lifecycle,
    runtimeContext,
    {
      metadataStore,
      sessionTitleGenerator: options.sessionTitleGenerator,
      autoGenerateSessionTitle: options.config.isSubagent !== true,
    },
    options.outputGate,
  );
  // 运行期 messages 投影化：有持久 transcript 路径时注入投影器——submit 的
  // 历史消息从 transcript（唯一真源）派生；内存 transcript（无路径）不注入，
  // AgentSession 回退到 state.messages（无持久层，无漂移可言）。
  // 投影器绑定实际 writer 的路径（而非 storage.transcriptPath），避免调用方
  // 传自定义 JsonlTranscriptWriter 时投影读错文件静默产生错误历史。
  const writerTranscriptPath = transcript instanceof JsonlTranscriptWriter ? transcript.path : undefined;
  const transcriptPath = writerTranscriptPath ?? storage?.transcriptPath ?? "";
  const projectMessages =
    transcriptPath.length > 0
      ? async () => {
          const { entries } = await readTranscript(transcriptPath);
          return projectMessagesFromTranscript(entries);
        }
      : undefined;

  return {
    session: new AgentSession({
      sessionId: options.sessionId,
      turnRunner,
      cwd: runtimeContext.cwd,
      transcriptPath: runtimeContext.transcriptPath,
      uuid: dependencies.uuid,
      initialState: options.initialState,
      replayEvents: options.replayEvents,
      lifecycle: dependencies.lifecycle,
      projectMessages,
    }),
    storage,
  };
}
