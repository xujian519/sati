import type { CanonicalContentBlock, CanonicalMessage } from "../model/index.js";
import { processPatentOutput, type QualityGateResult } from "./quality-gate.js";
import { createApprovalRecord, type ApprovalStore } from "./approval.js";

/**
 * PatentOutputGate — 把质量门禁接入 Agent 输出流。
 *
 * 在 AgentLoop 的 onDurableMessage（入库前）调用 processMessage：
 *   - 风险词命中 → 输出追加免责声明（照常入库）
 *   - 审批词命中且配置了 onPending → 消息挂起等待人工审批，但**仍照常入库**
 *     （processed 版本，含免责声明/存疑提示）：消息不丢失、转录顺序正确、
 *     会话重启后审批历史可恢复；approve()/reject() 仅为流程控制标记
 *     （触发宿主 onApproved/onRejected，从挂起队列移除）
 *   - 未配置 onPending 时审批词命中仅注入提示、不挂起（跑批安全，不丢消息）
 *   - 非 assistant 文本消息 / 含 tool_call 的消息直接放行
 *
 * 接入状态：TurnRunner.persistDurableMessage 已接线（createAgentSession options.outputGate
 * 注入）；挂起消息存于内存，宿主应提供 onPending 审批入口（approve/reject 后调用
 * TurnRunner.approvePendingOutput/rejectPendingOutput 完成流程控制）。会话重启后
 * 未决挂起队列会重建为空（挂起记录丢失），但消息本体已在转录中，不影响会话完整性。
 */

export type PendingPatentMessage = {
  index: number;
  /** 原始消息（审批 UI 展示用） */
  message: CanonicalMessage;
  /** 处理后的消息（含免责声明/存疑提示；已入库的版本） */
  processed: CanonicalMessage;
  /** 门禁判定结果 */
  info: QualityGateResult;
  /** 产生消息的会话/轮次（processMessage 传入，供审批 UI 定位与审计） */
  sessionId?: string;
  turnId?: string;
  createdAt: number;
};

export type PatentOutputGateOptions = {
  riskKeywords?: string[];
  approvalKeywords?: string[];
  absolutePhrases?: string[];
  disclaimer?: string;
  enableCitationGate?: boolean;
  /** 挂起队列容量上限（默认 100）：超出时放弃挂起、直接入库（不丢消息）。 */
  maxPending?: number;
  /** 挂起消息 TTL 毫秒（默认 0 = 不过期）：超期未审批自动清理并告警。 */
  pendingTtlMs?: number;
  /** 挂起回调：审批词命中且需人工审批时触发（接入审批 UI/宿主）。 */
  onPending?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批通过且写库成功后的回调（Commit 后触发）。 */
  onApproved?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批拒绝回调（Discard 后触发）。 */
  onRejected?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批审计存储（可选）：approve/reject 时追加 ApprovalRecord（决策留痕）。未配置则零开销。 */
  approvalStore?: ApprovalStore;
};

export type ProcessedMessageResult = {
  /** 写库用的消息（可能已追加免责声明/存疑提示；挂起时也已入库，不丢消息） */
  message: CanonicalMessage;
  /** 是否需人工审批（已挂起等待 approve/reject，approve/reject 仅为流程控制，消息本体已入库） */
  needsApproval: boolean;
  /** 挂起索引（needsApproval=true 时有效，供 approve/reject 使用） */
  pendingIndex?: number;
  /** 门禁判定结果 */
  info: QualityGateResult;
};

export class PatentOutputGate {
  private readonly pending = new Map<number, PendingPatentMessage>();
  private nextIndex = 0;
  private readonly options: PatentOutputGateOptions;

  constructor(options?: PatentOutputGateOptions) {
    this.options = options ?? {};
  }

  /** 处理一条待持久化的消息；返回写库用消息与是否挂起。context 为消息所属会话/轮次（记录进挂起条目供审批 UI 定位）。 */
  processMessage(message: CanonicalMessage, context?: { sessionId?: string; turnId?: string }): ProcessedMessageResult {
    if (!this.shouldProcess(message)) {
      return { message, needsApproval: false, info: emptyGateInfo() };
    }

    this.pruneExpired();

    const text = extractMessageText(message);
    const info = processPatentOutput(text, {
      riskKeywords: this.options.riskKeywords,
      approvalKeywords: this.options.approvalKeywords,
      absolutePhrases: this.options.absolutePhrases,
      disclaimer: this.options.disclaimer,
      enableCitationGate: this.options.enableCitationGate,
    });

    const processed = info.text === text ? message : replaceLastTextBlock(message, info.text);

    if (info.needsApproval && this.options.onPending) {
      const maxPending = this.options.maxPending ?? 100;
      if (this.pending.size >= maxPending) {
        // 队列已满：放弃挂起、直接入库（fail-open，保证用户可见回复不丢失；
        // 风险内容仍带免责声明/存疑提示。security 权衡已记录：严格合规场景
        // 应提高 maxPending 并确保审批端及时消费，或改为 fail-closed 拒绝输出）。
        console.warn(`[PatentOutputGate] 挂起队列已满（${maxPending}），审批词消息直接入库`);
        return { message: processed, needsApproval: false, info };
      }
      const index = this.nextIndex;
      this.nextIndex += 1;
      const pending: PendingPatentMessage = {
        index,
        message,
        processed,
        info,
        sessionId: context?.sessionId,
        turnId: context?.turnId,
        createdAt: Date.now(),
      };
      this.pending.set(index, pending);
      this.safeInvoke(this.options.onPending, pending);
      return { message: processed, needsApproval: true, pendingIndex: index, info };
    }

    return { message: processed, needsApproval: false, info };
  }

  /**
   * 审批通过：取出并移除挂起消息（消息已在挂起时入库，此处仅完成流程控制；触发 onApproved）。
   * sessionId 提供时校验匹配（防止跨会话越权批准）；不匹配返回 undefined。
   * 通过后写入审计记录（verdict=adopted）。
   */
  approve(index: number, sessionId?: string): PendingPatentMessage | undefined {
    const pending = this.pending.get(index);
    if (!pending) return undefined;
    if (sessionId !== undefined && pending.sessionId !== undefined && pending.sessionId !== sessionId) {
      return undefined;
    }
    this.pending.delete(index);
    this.recordApproval(pending, { verdict: "adopted" });
    return pending;
  }

  /** 审批通过且写库成功：触发 onApproved（语义 = 已持久化）。 */
  notifyCommitted(pending: PendingPatentMessage): void {
    this.safeInvoke(this.options.onApproved, pending);
  }

  /**
   * 审批拒绝：丢弃挂起消息。sessionId 提供时校验匹配（防止跨会话越权拒绝）。
   * feedback 可选（人工拒绝理由，写入审计）。拒绝后写入审计记录（verdict=rejected）。
   */
  reject(index: number, sessionId?: string, feedback?: string): boolean {
    const pending = this.pending.get(index);
    if (!pending) return false;
    if (sessionId !== undefined && pending.sessionId !== undefined && pending.sessionId !== sessionId) {
      return false;
    }
    this.pending.delete(index);
    this.recordApproval(pending, { verdict: "rejected", feedback });
    this.safeInvoke(this.options.onRejected, pending);
    return true;
  }

  /** 审计留痕（approve/reject 时调用；store 未配置时零开销，不阻塞流程）。 */
  private recordApproval(
    pending: PendingPatentMessage,
    decision: { verdict: "adopted" | "modified" | "rejected"; modifiedOutput?: string; feedback?: string },
  ): void {
    const store = this.options.approvalStore;
    if (!store) return;
    const record = createApprovalRecord({
      pendingIndex: pending.index,
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      triggerKeyword: pending.info.approvalKeywordsHit[0] ?? "unknown",
      originalOutputPreview: extractMessageText(pending.message),
      verdict: decision.verdict,
      ...(decision.modifiedOutput !== undefined ? { modifiedOutput: decision.modifiedOutput } : {}),
      ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
    });
    const result = store.saveRecord(record);
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(err => {
        console.error("[PatentOutputGate] 审批审计写入失败:", err);
      });
    }
  }

  /** 写库失败时恢复挂起（避免消息丢失），并重新触发 onPending 让审批端感知。 */
  restore(pending: PendingPatentMessage): void {
    if (!this.pending.has(pending.index)) {
      this.pending.set(pending.index, pending);
      this.safeInvoke(this.options.onPending, pending);
    }
  }

  pendingCount(): number {
    return this.pending.size;
  }

  pendingItems(): PendingPatentMessage[] {
    return [...this.pending.values()];
  }

  /** 清理超过 TTL 的挂起消息（默认不过期）；超期清理记告警（宿主应确保审批及时）。 */
  private pruneExpired(): void {
    const ttl = this.options.pendingTtlMs ?? 0;
    if (ttl <= 0) return;
    const now = Date.now();
    for (const [index, pending] of this.pending) {
      if (now - pending.createdAt > ttl) {
        this.pending.delete(index);
        console.warn(`[PatentOutputGate] 挂起消息 ${index} 超过 TTL（${ttl}ms）未审批，已清理`);
      }
    }
  }

  private shouldProcess(message: CanonicalMessage): boolean {
    if (message.role !== "assistant") return false;
    // 含工具调用/结果的消息不是面向用户的答案，跳过（与 Mady citationGate 一致）
    if (message.content.some(block => block.type === "tool_call" || block.type === "tool_result")) {
      return false;
    }
    return extractMessageText(message).trim().length > 0;
  }

  /** 安全调用回调：吞掉同步抛错与 rejected promise，避免 unhandled rejection。 */
  private safeInvoke(
    callback: ((pending: PendingPatentMessage) => void | Promise<void>) | undefined,
    pending: PendingPatentMessage,
  ): void {
    if (!callback) return;
    try {
      const result = callback(pending);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(err => {
          console.error("[PatentOutputGate] callback failed:", err);
        });
      }
    } catch (err) {
      console.error("[PatentOutputGate] callback failed:", err);
    }
  }
}

/** 提取消息的纯文本（text 块拼接，跳过 thinking/图片等）。 */
export function extractMessageText(message: CanonicalMessage): string {
  return message.content
    .filter((block): block is Extract<CanonicalContentBlock, { type: "text" }> => block.type === "text")
    .map(block => block.text)
    .join("\n");
}

/**
 * 把完整文本写入消息：第一个 text 块承载 fullText（原文+增量，只出现一次），
 * 其余 text 块丢弃（其文本已并入 fullText，避免重复）；非 text 块（thinking/图片等）原位保留。
 */
function replaceLastTextBlock(message: CanonicalMessage, fullText: string): CanonicalMessage {
  const content: CanonicalContentBlock[] = [];
  let inserted = false;
  for (const block of message.content) {
    if (block.type === "text") {
      if (!inserted) {
        content.push({ type: "text", text: fullText });
        inserted = true;
      }
      // 其余 text 块跳过：其文本已合并进 fullText
    } else {
      content.push(block);
    }
  }
  if (!inserted) {
    content.push({ type: "text", text: fullText });
  }
  return { ...message, content };
}

function emptyGateInfo(): QualityGateResult {
  return {
    text: "",
    riskKeywordsHit: [],
    approvalKeywordsHit: [],
    absolutePhrasesHit: [],
    needsApproval: false,
    disclaimerInjected: false,
    citationReport: { total: 0, valid: 0, unknown: 0, unverifiable: 0, suspect: 0, invalid: 0, flagged: [] },
  };
}
