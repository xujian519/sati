import type { CanonicalMessage, CanonicalModelEvent, CanonicalModelRequest } from "../../model/index.js";
import type {
  SatiElicitationChannel,
  SatiToolAuditRecorder,
  SatiFileUpdateNotifier,
  SatiToolFileHistorySink,
  SatiToolScheduler,
  ToolRegistry,
} from "../../tool/index.js";
import type { PlanFileManager } from "../../tool/builtin/planFile.js";
import type { LifecycleRuntime } from "../../lifecycle/index.js";
import type { AgentContextRuntime } from "../../context/ContextRuntime.js";
import type { TokenAccountingRuntime } from "../../context/index.js";
import type { RouterRuntime } from "../../router/index.js";
import type { SatiWorkspaceLedgerProvider } from "../../session/workspace/WorkspaceLedgerStore.js";
import type { AgentEvent, AgentEventEmitter } from "../protocol/events.js";
import type { DoomLoop } from "../loop/doomLoop.js";
import type { PlanTodoStateManager } from "./PlanTodoState.js";

/**
 * Narrow view of the router that the agent loop actually consumes. Tests can
 * inject anything that satisfies this contract; production wiring uses
 * `createRouterRuntime`.
 *
 * `decide` + `execute` are exposed so the agent loop can insert a post-routing
 * compaction pass between the routing decision and the model call.
 */
export type AgentRouterRuntime = Pick<RouterRuntime, "stream" | "decide" | "execute"> & {
  materializeRequest?: RouterRuntime["materializeRequest"];
  observeUsage?: RouterRuntime["observeUsage"];
  invalidateSticky?: RouterRuntime["invalidateSticky"];
};

/**
 * Subagent sidechain transcript hooks (C3 §6.3). The agent loop calls these
 * around a forked subagent so:
 *   - `recordSubagentStarted` writes a `subagent_started` reference into the
 *     **parent** transcript (truncated directive preview).
 *   - `recordSubagentCompleted` writes a `subagent_completed` reference into
 *     the **parent** transcript (truncated summary + usage / duration).
 *   - `subagentTranscriptResolver(subagentId)` returns a sidechain writer
 *     that captures the subagent's turn-by-turn entries into a separate
 *     `<subagentId>.jsonl` file.
 *
 * All hooks are optional — when missing, the agent loop falls back to the
 * legacy "no sidechain" behavior (subagent runs, but no persistence).
 */
export type AgentSubagentTranscriptHooks = {
  recordSubagentStarted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    prompt: string;
    transcriptRelativePath: string;
    subagentSessionId?: string;
  }): Promise<void>;
  recordSubagentCompleted?(args: {
    sessionId: string;
    turnId: string;
    subagentId: string;
    subagentType: string;
    summary: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      totalTokens?: number;
    };
    turns: number;
    durationMs: number;
    errored?: boolean;
  }): Promise<void>;
  subagentTranscriptResolver?(subagentId: string): {
    recordAcceptedInput(
      sessionId: string,
      turnId: string,
      messages: CanonicalMessage[],
      metadata?: Record<string, unknown>,
    ): Promise<void>;
    recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void>;
    /**
     * 可选：子代理收尾时排空 sidechain 写缓冲（sidechain 无 turn_result /
     * flushCheckpoint 调用点，仅靠 50ms 兜底定时器——进程在间隔内退出会丢
     * 尾条）。agent loop 在 subagent run 收尾后调用（成功/失败两路）。
     */
    flush?(): Promise<void>;
    transcriptRelativePath: string;
  };
};

export type AgentRuntimeDependencies = {
  router: AgentRouterRuntime;
  tools: {
    scheduler: SatiToolScheduler;
    registry: ToolRegistry;
  };
  context?: AgentContextRuntime;
  tokenAccounting?: TokenAccountingRuntime;
  /**
   * Look up a model's context-window size by provider/model id. Used after
   * routing to re-evaluate compaction against the target model's window when
   * it is smaller than the agent's default model. Returns `undefined` for
   * unknown models so the caller can skip re-compaction gracefully.
   */
  getModelMaxContextTokens?: (provider: string, model: string) => number | undefined;
  /**
   * Look up a model's maximum output-token cap by provider/model id. Used by
   * max-output recovery to avoid retrying with a lower synthetic default than
   * the selected model already receives from the catalog.
   */
  getModelMaxOutputTokens?: (provider: string, model: string) => number | undefined;
  getModelTokenLimits?: (
    provider: string,
    model: string,
  ) => { maxContextTokens: number; maxOutputTokens?: number } | undefined;
  now?: () => Date;
  uuid?: () => string;
  auditRecorder?: SatiToolAuditRecorder;
  lifecycle?: LifecycleRuntime;
  /** C3 sidechain transcript hooks (optional). */
  subagentTranscript?: AgentSubagentTranscriptHooks;
  /**
   * Elicitation channel — wired into the per-tool `SatiToolRuntimeContext`
   * so `ask_user_question` (B1) can drive the gateway. When omitted, the
   * tool returns a `mcp_unavailable` error instead of crashing.
   */
  elicitation?: SatiElicitationChannel;
  /**
   * File-history sink — wired into the per-tool runtime context so
   * `edit_file` / `write_file` (C4) snapshot the file before mutation.
   * `FileHistoryStore` directly satisfies this contract.
   */
  fileHistory?: SatiToolFileHistorySink;
  /**
   * Optional sink for propagating successful file writes to editor / LSP
   * integrations. When absent, write_file still succeeds and performs no
   * post-write host notifications.
   */
  fileUpdateNotifier?: SatiFileUpdateNotifier;
  /**
   * Plan file manager — resolves the project-local `.sati/plans`
   * directory and reads explicitly submitted plan documents for
   * `enter_plan_mode` / `exit_plan_mode`. Absent in headless / test runtimes.
   */
  planFileManager?: PlanFileManager;
  /** Session-scoped state tracking required `todo_write` calls after plan approval. */
  planTodoManager?: PlanTodoStateManager;
  /**
   * DoomLoop 死循环检测器（可选）。注入后 agent 循环在每次模型输出/工具执行
   * 后观测，命中信号发射 `doomloop_signal` 事件；fatal 信号（受 DoomLoop
   * 开关约束）终止当前 turn。未注入时零开销。
   */
  doomLoop?: DoomLoop;
  /**
   * 工作区账本 provider（可选）。提供读取/写入五元组账本（Goal/Core/Verified/
   * Open/Next）的能力；账本从 transcript 派生、每次模型调用前重新注入，从而
   * 跨压缩存续。未注入时零开销（不注入、不写 seam）。
   */
  workspaceLedger?: SatiWorkspaceLedgerProvider;
  eventEmitter?: AgentEventEmitter;
  drainEvents?: () => AgentEvent[];
};

export type AgentLegacyModelRuntime = {
  stream(request: CanonicalModelRequest, signal?: AbortSignal): AsyncIterable<CanonicalModelEvent>;
};
