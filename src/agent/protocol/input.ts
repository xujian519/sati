import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import type { PermissionMode, PermissionRuleSet } from "../../permission/index.js";
import type { InjectionRecord } from "../../context/protocol/types.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentRequestHeaderSnapshot,
} from "../../session/transcript/TranscriptEntry.js";
import type { AgentStatusMessage } from "../loop/modelErrors.js";

export type AgentRunMode = "agent" | "plan" | "ask";

/** AgentLoop 单轮执行输入契约（原定义于 AgentLoop.ts，迁至协议层避免循环依赖）。 */
export type AgentLoopInput = {
  sessionId: string;
  turnId: string;
  messages: CanonicalMessage[];
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
  onDurableMessage?: (message: CanonicalMessage) => void | Promise<void>;
  onAgentStatusMessage?: (status: AgentStatusMessage) => void | Promise<void>;
  onCompactPersisted?: (input: {
    boundary: AgentControlBoundaryTranscriptEntry["boundary"];
    messages: CanonicalMessage[];
  }) => void | Promise<void>;
  /**
   * 注入内容参考条目回调（「模型可见 = 已记录」）：模型实际看到的动态注入
   * 段落（记忆/项目指令/记忆工具提示/方法论）原文。调用方落 transcript 为
   * `injected_context` 条目，重放投影时不进入模型可见 messages。
   */
  onInjectedContext?: (input: { injections: InjectionRecord[] }) => void | Promise<void>;
  /**
   * 发送前请求头快照回调（阶段四 T2）：调用方落 transcript 为
   * request_header 条目（log-only，重放投影不进入 messages）。
   */
  onRequestHeader?: (header: AgentRequestHeaderSnapshot) => void | Promise<void>;
  /**
   * durable 边界检查点回调（阶段四 T4.1）：工具副作用执行前调用，确保此前
   * 全部已接受条目落盘。失败即中止本步（fail-closed）；未接线时 no-op。
   */
  onFlushCheckpoint?: () => void | Promise<void>;
};

export type AgentInput =
  | { type: "text"; text: string; isMeta?: boolean }
  | { type: "blocks"; content: CanonicalContentBlock[]; isMeta?: boolean };

export type AgentSubmitOptions = {
  turnId?: string;
  maxTurns?: number;
  metadata?: Record<string, unknown>;
  runMode?: AgentRunMode;
  permissionMode?: PermissionMode;
  allowedReadFiles?: string[];
  /** The user's actual permission preference before plan-mode override. */
  basePermissionMode?: PermissionMode;
  /** Allow model-visible plan mode tools for this turn. */
  allowPlanModeTools?: boolean;
  canPrompt?: boolean;
  permissionRules?: Partial<PermissionRuleSet>;
  /**
   * Synthetic messages appended after the user input in the turn.
   * Stored in transcript with `metadata.synthetic: true` so they are
   * visible to the model but filtered out of the Web UI display.
   */
  syntheticMessages?: import("../../model/index.js").CanonicalMessage[];
};
