import { randomUUID } from "node:crypto";
import type { CanonicalMessage } from "../../model/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import type { AgentTranscriptReplayResult } from "../../session/transcript/TranscriptReplay.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { TurnRunner } from "../turn/TurnRunner.js";
import type { AgentTranscriptWriterState } from "../../session/transcript/TranscriptWriter.js";
import type { AgentLoopSeedState } from "../loop/AgentLoop.js";
import {
  appendPermissionDenials,
  cloneSessionStateForRuntimeReload,
  createInitialAgentSessionState,
  mergeSessionUsage,
  snapshotAgentSessionState,
} from "./AgentSessionState.js";

export type AgentSessionOptions = {
  sessionId: string;
  turnRunner: TurnRunner;
  cwd?: string;
  transcriptPath?: string;
  uuid?: () => string;
  initialState?: AgentSessionStateShape;
  replayEvents?: AgentEvent[];
  lifecycle?: LifecycleRuntime;
  /**
   * 历史消息投影器（运行期 messages 投影化）：从 transcript（唯一真源）
   * 派生 submit 输入的历史消息。注入后 submit 不再使用内存累积的
   * `state.messages`，消除内存态与持久态漂移。未注入（内存 transcript /
   * 测试）时回退到 `state.messages`（无持久层，无漂移可言）。
   */
  projectMessages?: () => Promise<CanonicalMessage[]>;
};

export type AgentSessionRuntimeReloadSnapshot = {
  state: AgentSessionStateShape;
  cwd: string;
  transcriptPath: string;
  transcriptWriterState?: AgentTranscriptWriterState;
  fileState?: AgentLoopSeedState;
  metadata?: SessionMetadataValue;
};

export class AgentSession {
  private state: AgentSessionStateShape;

  constructor(private readonly options: AgentSessionOptions) {
    this.state = options.initialState ?? createInitialAgentSessionState(options.sessionId);
  }

  /** 审批通过挂起的门禁消息（输出级 HITL）：消息已在挂起时入库，此处仅完成审批流程控制。sessionId 自动绑定本会话，防跨会话越权。 */
  approvePendingOutput(index: number): boolean {
    return this.options.turnRunner.approvePendingOutput(index, this.state.sessionId);
  }

  /** 拒绝挂起的门禁消息：从挂起队列移除（消息本体已在转录中，不删除）。sessionId 自动绑定本会话，防跨会话越权。feedback 为可选人工拒绝理由（写入审计记录）。 */
  rejectPendingOutput(index: number, feedback?: string): boolean {
    return this.options.turnRunner.rejectPendingOutput(index, this.state.sessionId, feedback);
  }

  async *submit(input: AgentInput, submitOptions: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
    const turnId = submitOptions.turnId ?? this.nextId();
    this.state.status = "running";
    this.state.currentTurnId = turnId;
    this.state.abortController = new AbortController();
    yield { type: "session_started", sessionId: this.state.sessionId };
    await this.options.lifecycle?.dispatch({
      event: "SessionStart",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { source: "startup" },
      matchQuery: "SessionStart",
      signal: this.state.abortController.signal,
    });
    await this.options.lifecycle?.dispatch({
      event: "Setup",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: {},
      matchQuery: "Setup",
      signal: this.state.abortController.signal,
    });
    yield { type: "setup_completed", sessionId: this.state.sessionId };

    // 运行期 messages 投影化：有投影器时历史消息从 transcript（唯一真源）
    // 派生，替代内存累积的 state.messages——持久层为准，消除漂移。
    const historyMessages = this.options.projectMessages ? await this.options.projectMessages() : this.state.messages;

    const runResult = yield* this.options.turnRunner.run({
      sessionId: this.state.sessionId,
      turnId,
      messages: historyMessages,
      input,
      maxTurns: submitOptions.maxTurns,
      runMode: submitOptions.runMode,
      permissionMode: submitOptions.permissionMode,
      allowedReadFiles: submitOptions.allowedReadFiles,
      basePermissionMode: submitOptions.basePermissionMode,
      allowPlanModeTools: submitOptions.allowPlanModeTools,
      canPrompt: submitOptions.canPrompt,
      permissionRules: submitOptions.permissionRules,
      syntheticMessages: submitOptions.syntheticMessages,
      appendSystemPrompt: submitOptions.appendSystemPrompt,
      abortSignal: this.state.abortController.signal,
    });

    this.state.messages = runResult.messages;
    this.state.usage = mergeSessionUsage(this.state.usage, runResult.result.usage);
    this.state.permissionDenials = appendPermissionDenials(
      this.state.permissionDenials,
      runResult.result.permissionDenials,
    );
    this.state.status =
      runResult.result.type === "aborted" ? "aborted" : runResult.result.type === "error" ? "failed" : "idle";
    this.state.currentTurnId = undefined;
    const sessionEndReason = this.state.status === "aborted" ? "other" : "prompt_input_exit";
    await this.options.lifecycle?.dispatch({
      event: "SessionEnd",
      baseInput: {
        sessionId: this.state.sessionId,
        transcriptPath: this.options.transcriptPath ?? "",
        cwd: this.options.cwd ?? process.cwd(),
      },
      payload: { reason: sessionEndReason },
      matchQuery: "SessionEnd",
      signal: this.state.abortController.signal,
    });
    yield { type: "session_ended", sessionId: this.state.sessionId, reason: sessionEndReason };
  }

  abort(reason?: string): void {
    this.state.abortController.abort(reason);
    this.state.status = "aborted";
  }

  snapshot(): AgentSessionStateShape {
    return snapshotAgentSessionState(this.state);
  }

  snapshotForRuntimeReload(): AgentSessionRuntimeReloadSnapshot {
    const runtime = this.options.turnRunner.snapshotForRuntimeReload();
    return {
      state: cloneSessionStateForRuntimeReload(this.state),
      cwd: runtime.runtimeContext.cwd,
      transcriptPath: runtime.runtimeContext.transcriptPath,
      transcriptWriterState: runtime.transcriptWriterState,
      fileState: this.options.turnRunner.snapshotFileState(),
      metadata: runtime.metadata,
    };
  }

  async *replay(): AsyncGenerator<AgentEvent, void, unknown> {
    for (const event of this.options.replayEvents ?? []) {
      yield event;
    }
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }
}

export function createAgentSessionStateFromReplay(
  sessionId: string,
  replay: AgentTranscriptReplayResult,
): AgentSessionStateShape {
  return {
    ...createInitialAgentSessionState(sessionId),
    messages: replay.messages,
    usage: replay.usage,
    permissionDenials: replay.permissionDenials,
  };
}
