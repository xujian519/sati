import { agentError, normalizeAgentError } from "../protocol/errors.js";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentRunMode } from "../protocol/input.js";
import type { AgentTurnResult } from "../protocol/result.js";
import type { AgentLoop, AgentLoopSeedState } from "../loop/AgentLoop.js";
import type {
  AgentTranscriptWriter,
  AgentStatusMessageInput,
  AgentTranscriptWriterState,
} from "../../session/transcript/TranscriptWriter.js";
import type { CanonicalMessage, CanonicalUsage } from "../../model/index.js";
import { createLogger } from "../../telemetry/index.js";
import type { PatentOutputGate } from "../../patent/index.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { SessionMetadataStore } from "../../session/metadata/SessionMetadataStore.js";
import type { SessionMetadataValue } from "../../session/transcript/TranscriptEntry.js";
import type { SessionTitleGenerator } from "../../session/title/SessionTitleGenerator.js";
import { createVisibleErrorStatusDetail } from "../../status/agentStatus.js";
import { FileArtifactCollector, type FileArtifact } from "../../session/artifacts/index.js";
import { sanitizeAgentInput } from "./sanitizeAgentInput.js";
import { TurnInputProcessor } from "./TurnInputProcessor.js";

const logger = createLogger("agent");

export type TurnRunnerOptions = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
  input: AgentInput;
  maxTurns?: number;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  abortSignal?: AbortSignal;
  /** Synthetic messages appended after user input; stored with metadata.synthetic flag. */
  syntheticMessages?: CanonicalMessage[];
  /** 本回合系统提示追加段（如团队成员角色提示）；透传给 AgentLoop。 */
  appendSystemPrompt?: string;
};

export type TurnRunnerResult = {
  result: AgentTurnResult;
  messages: CanonicalMessage[];
};

export type TurnRunnerRuntimeContext = {
  cwd: string;
  transcriptPath: string;
  /** Disable Agent-generated file artifact collection for non-project chats. */
  collectFileArtifacts?: boolean;
};

export type TurnRunnerRuntimeReloadSnapshot = {
  runtimeContext: TurnRunnerRuntimeContext;
  transcriptWriterState?: AgentTranscriptWriterState;
  metadata?: SessionMetadataValue;
};

export type TurnRunnerDependencies = {
  metadataStore?: SessionMetadataStore;
  sessionTitleGenerator?: SessionTitleGenerator;
  autoGenerateSessionTitle?: boolean;
};

type PendingSessionTitle = {
  controller: AbortController;
  cleanup: () => void;
  completed: boolean;
  title: string | null;
  /** Settles when the title generation finishes (success, failure, or timeout). */
  promise: Promise<void>;
};

/** 会话列表展示的 prompt 摘要长度上限（截断避免超大输入拖垮列表加载）。 */
const SESSION_LISTING_PROMPT_MAX_CHARS = 1_200;

export class TurnRunner {
  /** 会话已关闭（上游 #568）：置位后不再启动后台标题生成，且其迟到结果不再落盘。 */
  private disposed = false;
  private pendingSessionTitle: PendingSessionTitle | undefined;

  constructor(
    private readonly loop: AgentLoop,
    private readonly transcript: AgentTranscriptWriter,
    private readonly inputProcessor = new TurnInputProcessor(),
    private readonly now: () => Date = () => new Date(),
    private readonly lifecycle?: LifecycleRuntime,
    private readonly runtimeContext: TurnRunnerRuntimeContext = {
      cwd: process.cwd(),
      transcriptPath: "",
    },
    private readonly turnDependencies: TurnRunnerDependencies = {},
    /** 专利输出门禁（可选）：在消息入库前拦截，命中审批词时挂起等待人工审批。 */
    private readonly outputGate?: PatentOutputGate,
  ) {}

  /**
   * 门禁感知的持久化：有门禁时先处理（注入免责声明/存疑提示）。
   * 命中审批词需人工审批的消息**也照常入库**（processed 版本）：不丢消息、
   * 转录顺序正确；挂起队列仅用于审批流程控制（approve/reject 不再补写或丢弃）。
   * onPending 在写入成功后触发（flushPending）；写入失败撤销挂起（cancelPending）——
   * 审批端感知到的挂起条目保证消息已在转录中（不出现悬空挂起）。
   */
  private async persistDurableMessage(
    sessionId: string,
    turnId: string,
    msg: CanonicalMessage,
    options?: { skipApproval?: boolean },
  ): Promise<void> {
    if (this.outputGate) {
      const { message, needsApproval, pendingIndex } = this.outputGate.processMessage(msg, {
        sessionId,
        turnId,
        skipApproval: options?.skipApproval === true,
      });
      try {
        await this.transcript.recordDurableMessage(sessionId, turnId, message);
      } catch (err) {
        // 写入失败：撤销挂起（onPending 尚未触发、消息未入库，无审批意义）
        if (needsApproval && pendingIndex !== undefined) {
          this.outputGate.cancelPending(pendingIndex);
        }
        throw err;
      }
      if (needsApproval && pendingIndex !== undefined) {
        this.outputGate.flushPending(pendingIndex); // 写入确认后触发 onPending
      }
      return;
    }
    await this.transcript.recordDurableMessage(sessionId, turnId, msg);
  }

  /** 审批通过挂起的门禁消息：从挂起队列取出并触发 onApproved（消息在挂起时已入库，无需补写）。sessionId 匹配校验防越权。 */
  approvePendingOutput(index: number, sessionId?: string): boolean {
    if (!this.outputGate) return false;
    const pending = this.outputGate.approve(index, sessionId);
    if (!pending) return false;
    this.outputGate.notifyCommitted(pending);
    return true;
  }

  /** 拒绝挂起的门禁消息：从挂起队列移除并触发 onRejected（消息已入库，不删除转录）。sessionId 匹配校验防越权。feedback 为可选人工拒绝理由（写入审计记录）。 */
  rejectPendingOutput(index: number, sessionId?: string, feedback?: string): boolean {
    if (!this.outputGate) return false;
    return this.outputGate.reject(index, sessionId, feedback);
  }

  async *run(options: TurnRunnerOptions): AsyncGenerator<AgentEvent, TurnRunnerResult, unknown> {
    yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
    // 外发脱敏：凭证类内容在进入 transcript / 模型可见消息之前替换（W1）。
    const sanitized = sanitizeAgentInput(options.input);
    const accepted = this.inputProcessor.accept(sanitized.input);
    const allAcceptedMessages = [...accepted.messages, ...(options.syntheticMessages ?? [])];
    const messages = [...options.messages, ...allAcceptedMessages];

    try {
      await this.transcript.recordAcceptedInput(
        options.sessionId,
        options.turnId,
        allAcceptedMessages,
        acceptedInputMetadata(options),
      );
    } catch (error) {
      const agentTranscriptError = agentError("agent_transcript_error", "Failed to record accepted input.", error);
      const result = this.createErrorResult(options, agentTranscriptError);
      const status = await this.recordTurnFailureStatus(options, agentTranscriptError);
      yield this.toAgentStatusEvent(options, status);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: agentTranscriptError };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages: options.messages };
    }

    await this.persistListingPromptMetadata(options, accepted.messages);
    yield { type: "input_accepted", sessionId: options.sessionId, turnId: options.turnId, messages: accepted.messages };

    // 先确认 durable 输入再扫描工作区（上游 #568）：基线仍早于 hooks/模型/工具
    // 任何可能的文件改动，但长耗时的工作区扫描不再推迟 input_accepted 的送达。
    const artifactCollector =
      this.runtimeContext.collectFileArtifacts === false
        ? undefined
        : await FileArtifactCollector.start({
            cwd: this.runtimeContext.cwd,
            allowedInputPaths: options.allowedReadFiles,
            now: this.now,
          }).catch(() => undefined);
    let artifactsFinished = false;
    const finishArtifacts = async (result: AgentTurnResult): Promise<FileArtifact[]> => {
      if (!artifactCollector || artifactsFinished) return [];
      artifactsFinished = true;
      const artifacts = await artifactCollector
        .finish(result.type === "success" ? "complete" : "incomplete")
        .catch(() => []);
      if (artifacts.length > 0) {
        await Promise.resolve(
          this.transcript.recordFileArtifacts?.(options.sessionId, options.turnId, artifacts),
        ).catch(error => logger.warn("recordFileArtifacts failed:", error));
      }
      return artifacts;
    };

    const prompt = inputToPromptText(sanitized.input);
    const userPromptHooks = await this.lifecycle?.dispatch({
      event: "UserPromptSubmit",
      baseInput: {
        sessionId: options.sessionId,
        transcriptPath: this.runtimeContext.transcriptPath,
        cwd: this.runtimeContext.cwd,
      },
      payload: { prompt },
      matchQuery: "UserPromptSubmit",
      signal: options.abortSignal,
    });
    yield { type: "user_prompt_submitted", sessionId: options.sessionId, turnId: options.turnId, prompt };
    if (sanitized.redacted) {
      yield {
        type: "warning",
        sessionId: options.sessionId,
        turnId: options.turnId,
        code: "payload_redacted",
        message:
          "Credentials detected in the input (API key / URL credentials / secret assignment) were redacted before sending to the model.",
      };
    }
    if (userPromptHooks?.effects.some(effect => effect.type === "block")) {
      const error = agentError("agent_unsupported_feature", "UserPromptSubmit hook blocked model execution.");
      const result = this.createErrorResult(options, error);
      await this.recordErrorResult(options, result);
      const artifacts = await finishArtifacts(result);
      if (artifacts.length > 0) {
        yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
      }
      const status = await this.recordTurnFailureStatus(options, error);
      yield this.toAgentStatusEvent(options, status);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
    messages.push(...(userPromptHooks?.messages ?? []));

    const sessionTitle = this.maybeGenerateSessionTitle(options, accepted.messages);

    if (!accepted.shouldCallModel) {
      const error = agentError(
        "agent_unsupported_feature",
        "Input was accepted but model execution was not requested.",
      );
      const result = this.createErrorResult(options, error);
      await this.recordErrorResult(options, result);
      const artifacts = await finishArtifacts(result);
      if (artifacts.length > 0) {
        yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
      }
      const status = await this.recordTurnFailureStatus(options, error);
      yield this.toAgentStatusEvent(options, status);
      await this.finalizeSessionMetadata(options, sessionTitle);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }

    try {
      let hasRecordedVisibleFailureStatus = false;
      const generator = this.loop.run({
        sessionId: options.sessionId,
        turnId: options.turnId,
        messages,
        maxTurns: options.maxTurns,
        runMode: options.runMode,
        permissionMode: options.permissionMode,
        allowedReadFiles: options.allowedReadFiles,
        basePermissionMode: options.basePermissionMode,
        allowPlanModeTools: options.allowPlanModeTools,
        canPrompt: options.canPrompt,
        permissionRules: options.permissionRules,
        appendSystemPrompt: options.appendSystemPrompt,
        abortSignal: options.abortSignal,
        onDurableMessage: msg => this.persistDurableMessage(options.sessionId, options.turnId, msg),
        onAgentStatusMessage: async status => {
          if (isVisibleFailureStatus(status)) {
            hasRecordedVisibleFailureStatus = true;
          }
          await this.transcript.recordAgentStatusMessage?.(options.sessionId, options.turnId, status);
        },
        onCompactPersisted: async ({ boundary, messages: compactMessages }) => {
          await this.transcript.recordControlBoundary?.(options.sessionId, options.turnId, boundary);
          for (const message of compactMessages) {
            // 压缩重放的消息同样经过门禁（免责声明等质量处理，避免摘要绕过门禁）；
            // skipApproval=true：这些消息首次入库时已走过审批流程，重放不重复挂起
            await this.persistDurableMessage(options.sessionId, options.turnId, message, { skipApproval: true });
          }
        },
        onInjectedContext: async ({ injections }) => {
          for (const injection of injections) {
            await this.transcript.recordInjectedContext?.(options.sessionId, options.turnId, injection);
          }
        },
        onRequestHeader: async header => {
          await this.transcript.recordRequestHeader?.(options.sessionId, options.turnId, header);
        },
        onFlushCheckpoint: async () => {
          await this.transcript.flushCheckpoint?.();
        },
      });
      let runResult: TurnRunnerResult | undefined;
      let turnCompletedEvent: Extract<AgentEvent, { type: "turn_completed" }> | undefined;
      while (true) {
        const next = await generator.next();
        if (next.done) {
          runResult = next.value;
          break;
        }
        const event = next.value;
        if (event.type === "tool_result") {
          artifactCollector?.observeToolResult(event.result);
        }
        if (event.type === "file_artifacts") {
          continue;
        }
        if (event.type === "turn_completed") {
          turnCompletedEvent = event;
          continue;
        }
        if (event.type === "turn_failed" && !hasRecordedVisibleFailureStatus) {
          const status = await this.recordTurnFailureStatus(options, event.error);
          hasRecordedVisibleFailureStatus = true;
          yield this.toAgentStatusEvent(options, status);
        }
        yield event;
      }

      const artifacts = await finishArtifacts(runResult.result);
      if (artifacts.length > 0) {
        yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
      }
      // turn_completed 在结果落盘与 metadata 收尾之后才外发（上游 #568）：
      // 消费者收到"回合结束"时，转录尾部必然已是最终状态。
      await this.transcript.recordTurnResult(options.sessionId, options.turnId, runResult.result);
      await this.finalizeSessionMetadata(options, sessionTitle);
      if (turnCompletedEvent) {
        yield turnCompletedEvent;
      }
      return runResult;
    } catch (error) {
      const normalized = normalizeAgentError(error);
      const result = this.createErrorResult(options, normalized);
      const artifacts = await finishArtifacts(result);
      if (artifacts.length > 0) {
        yield { type: "file_artifacts", sessionId: options.sessionId, turnId: options.turnId, artifacts };
      }
      await Promise.resolve(this.transcript.recordTurnResult(options.sessionId, options.turnId, result)).catch(
        () => {},
      );
      const status = await this.recordTurnFailureStatus(options, normalized);
      yield this.toAgentStatusEvent(options, status);
      await this.finalizeSessionMetadata(options, sessionTitle);
      yield { type: "turn_failed", sessionId: options.sessionId, turnId: options.turnId, error: normalized };
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages };
    }
  }

  snapshotForRuntimeReload(): TurnRunnerRuntimeReloadSnapshot {
    return {
      runtimeContext: { ...this.runtimeContext },
      transcriptWriterState: this.transcript.snapshotState?.(),
      metadata: this.turnDependencies.metadataStore?.getSnapshot(),
    };
  }

  snapshotFileState(): AgentLoopSeedState {
    return this.loop.snapshotFileState();
  }

  private createErrorResult(options: TurnRunnerOptions, error: ReturnType<typeof agentError>): AgentTurnResult {
    const timestamp = this.now().toISOString();
    return {
      type: "error",
      sessionId: options.sessionId,
      turnId: options.turnId,
      stopReason: error.code === "agent_aborted" ? "aborted_streaming" : "model_error",
      usage: emptyUsage(),
      permissionDenials: [],
      turns: 0,
      startedAt: timestamp,
      completedAt: timestamp,
      errors: [error],
    };
  }

  private async recordErrorResult(_options: TurnRunnerOptions, result: AgentTurnResult): Promise<void> {
    await Promise.resolve(this.transcript.recordTurnResult(result.sessionId, result.turnId, result)).catch(error =>
      logger.warn("recordTurnResult failed:", error),
    );
  }

  private async recordTurnFailureStatus(
    options: TurnRunnerOptions,
    error: ReturnType<typeof agentError>,
  ): Promise<AgentStatusMessageInput> {
    const status = this.createTurnFailureStatus(error);
    await Promise.resolve(this.transcript.recordAgentStatusMessage?.(options.sessionId, options.turnId, status)).catch(
      recordError => logger.warn("recordAgentStatusMessage failed:", recordError),
    );
    return status;
  }

  private createTurnFailureStatus(error: ReturnType<typeof agentError>): AgentStatusMessageInput {
    return {
      event: "turn_failed",
      kind: "error",
      text: error.message,
      detail: createVisibleErrorStatusDetail({
        message: error.message,
        code: error.code,
        userHint: error.userHint ?? "Retry the turn; if it repeats, check the gateway logs or adjust the request.",
        scope: "turn",
        source: "agent",
      }),
    };
  }

  private toAgentStatusEvent(options: TurnRunnerOptions, status: AgentStatusMessageInput): AgentEvent {
    return {
      type: "agent_status",
      sessionId: options.sessionId,
      turnId: options.turnId,
      event: status.event,
      detail: status.detail,
    };
  }

  private maybeGenerateSessionTitle(
    options: TurnRunnerOptions,
    acceptedMessages: CanonicalMessage[],
  ): PendingSessionTitle | undefined {
    if (this.disposed || this.turnDependencies.autoGenerateSessionTitle !== true) {
      return undefined;
    }
    const metadataStore = this.turnDependencies.metadataStore;
    const generateTitle = this.turnDependencies.sessionTitleGenerator;
    if (!metadataStore || !generateTitle) {
      return undefined;
    }
    const snapshot = metadataStore.getSnapshot();
    if (snapshot.title || snapshot.aiTitle) {
      return undefined;
    }
    if (this.pendingSessionTitle && !this.pendingSessionTitle.completed) {
      return this.pendingSessionTitle;
    }
    const text = allHumanText([...options.messages, ...acceptedMessages]);
    if (!text) {
      return undefined;
    }

    const controller = new AbortController();
    const cleanup = linkAbortSignal(options.abortSignal, controller);
    const pending: PendingSessionTitle = {
      controller,
      cleanup,
      completed: false,
      title: null,
      promise: generateTitle({
        text,
        sessionId: options.sessionId,
        turnId: options.turnId,
        signal: controller.signal,
      })
        .then(async title => {
          // 会话已关闭或本轮已中止：迟到的标题不得写回（上游 #568）。provider 可能
          // 无视取消，故这里以标志位兜底，而不是依赖 abort 生效。
          if (this.disposed || controller.signal.aborted) return;
          pending.title = title;
          if (title) {
            const snap = metadataStore.getSnapshot();
            if (!snap.title && !snap.aiTitle) {
              await metadataStore.saveAiTitle(title, options.turnId);
            }
          }
        })
        .catch(error => logger.warn("session title generation failed:", error))
        .finally(() => {
          pending.completed = true;
          cleanup();
        }),
    };
    this.pendingSessionTitle = pending;
    return pending;
  }

  /**
   * 会话关闭（上游 #568）：作废后台工作，之后转录不再接受写入。
   * 生成标题的 provider 可能无视取消——不等它的网络请求，靠上面的完成守卫
   * 保证迟到标题永远写不回来。
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    this.pendingSessionTitle?.controller.abort("session_closed");
    this.pendingSessionTitle?.cleanup();
    await this.transcript.close?.();
  }

  /**
   * turn 收尾（上游 #568）：把当前 metadata 快照 reappend 到转录尾部。
   * 标题生成不再在此阻塞——它的完成回调自行落盘（`record()` 会把增量
   * 元数据写进转录尾部），因此后续 turn 可以在标题仍在生成时继续。
   */
  private async finalizeSessionMetadata(options: TurnRunnerOptions, pending?: PendingSessionTitle): Promise<void> {
    // 标题完成会自动落盘；此处只解除它对本轮的 abort 联动，不等待其 settle。
    pending?.cleanup();
    await this.turnDependencies.metadataStore?.reappendTail(options.turnId).catch(() => {});
    // M3 写缓冲适配：reappend 的条目排在 turn_result 强制 flush **之后**的批次里，
    // 其 ack 只能等 unref 兜底定时器——而 turn 边界按约定不依赖它。这里显式冲刷，
    // 使 turn_completed 发出时转录尾部（含 metadata 快照）确已落盘（上游 #568 不变式）。
    await Promise.resolve(this.transcript.flushCheckpoint?.()).catch(() => {});
  }

  /** 记录列表用 firstPrompt/lastPrompt（截断），供会话列表大附件兜底恢复。 */
  private async persistListingPromptMetadata(
    options: TurnRunnerOptions,
    acceptedMessages: CanonicalMessage[],
  ): Promise<void> {
    const metadataStore = this.turnDependencies.metadataStore;
    if (!metadataStore) return;

    const snapshot = metadataStore.getSnapshot();
    const prompt = allHumanText(acceptedMessages);
    if (!prompt) return;

    const boundedPrompt = prompt.slice(0, SESSION_LISTING_PROMPT_MAX_CHARS);
    await metadataStore
      .record(options.turnId, {
        ...(snapshot.firstPrompt ? {} : { firstPrompt: boundedPrompt }),
        lastPrompt: boundedPrompt,
        updatedAt: this.now().toISOString(),
      })
      .catch(() => {});
  }
}

function isVisibleFailureStatus(status: AgentStatusMessageInput): boolean {
  return status.kind === "error" && status.event !== "turn_failed";
}

function acceptedInputMetadata(options: TurnRunnerOptions): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  if (options.permissionMode) {
    metadata.permissionMode = options.permissionMode;
  }
  if (options.runMode) {
    metadata.runMode = options.runMode;
  }
  if (options.basePermissionMode) {
    metadata.basePermissionMode = options.basePermissionMode;
  }
  if (options.allowPlanModeTools !== undefined) {
    metadata.allowPlanModeTools = options.allowPlanModeTools;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function emptyUsage(): CanonicalUsage {
  return {};
}

function inputToPromptText(input: AgentInput): string {
  if (input.type === "text") {
    return input.text;
  }
  return input.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

function allHumanText(messages: CanonicalMessage[]): string | null {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.metadata?.synthetic) {
      continue;
    }
    const text = message.content
      .filter(block => block.type === "text")
      .map(block => (block.type === "text" ? block.text : ""))
      .join("\n")
      .trim();
    if (text) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function linkAbortSignal(source: AbortSignal | undefined, controller: AbortController): () => void {
  if (!source) {
    return () => {};
  }
  if (source.aborted) {
    controller.abort(source.reason);
    return () => {};
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}
