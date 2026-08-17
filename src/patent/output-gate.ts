import type { CanonicalContentBlock, CanonicalMessage } from "../model/index.js";
import type { RuleOutputGate, RuleViolation } from "../rule/index.js";
import { processPatentOutput, type QualityGateResult } from "./quality-gate.js";
import { createApprovalRecord, type ApprovalRecord, type ApprovalStore } from "./approval.js";

/**
 * PatentOutputGate — 把质量门禁接入 Agent 输出流。
 *
 * 在 AgentLoop 的 onDurableMessage（入库前）调用 processMessage：
 *   - 风险词命中 → 输出追加免责声明（照常入库）
 *   - 审批词命中且配置了 onPending → 消息挂起等待人工审批，但**仍照常入库**
 *     （processed 版本，含免责声明/存疑提示）：消息不丢失、转录顺序正确、
 *     会话重启后审批历史可恢复；approve()/reject() 仅为流程控制标记
 *     （触发宿主 onApproved/onRejected，从挂起队列移除）
 *   - onPending 在转录写入**确认后**触发（宿主调 flushPending；写入失败调
 *     cancelPending 撤销挂起）——审批端感知到的挂起条目保证消息已在转录中
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
  /** 规则门禁违规清单（配置 ruleGate 时才有；供审批 UI 展示规则依据，含 warn/block/review） */
  ruleViolations?: RuleViolation[];
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
  /**
   * 规则驱动门禁（可选）：关键词门禁之后串接。block/review 命中同样挂起审批
   * （复用同一 pending/approve/reject 流程控制），warn 命中追加合规提示。
   * 未配置时行为与历史一致（仅关键词门禁）。
   */
  ruleGate?: RuleOutputGate;
  /** 挂起队列容量上限（默认 100）：超出时放弃挂起、直接入库（不丢消息）。 */
  maxPending?: number;
  /** 挂起消息 TTL 毫秒（默认 0 = 不过期）：超期未审批自动清理并告警。 */
  pendingTtlMs?: number;
  /** 挂起回调：审批词命中且需人工审批时触发（接入审批 UI/宿主）。转录写入确认后触发（见 flushPending）。 */
  onPending?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批通过且写库成功后的回调（Commit 后触发）。 */
  onApproved?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批拒绝回调（Discard 后触发）。 */
  onRejected?: (pending: PendingPatentMessage) => void | Promise<void>;
  /** 审批审计存储（可选）：approve/reject 时追加 ApprovalRecord（决策留痕）。未配置则零开销。 */
  approvalStore?: ApprovalStore;
  /**
   * 决策反馈回调（可选，P2-4）：verdict = modified/rejected 时触发，携带审计记录
   * （含原文摘录与人工反馈）。宿主可接线写入 `data/cases/<caseId>/inventiveness-feedback.jsonl`
   * （见 feedback/inventiveness-feedback.ts）；未配置零开销。
   */
  onDecisionFeedback?: (record: ApprovalRecord) => void | Promise<void>;
  /** 可注入时钟（毫秒时间戳；默认 Date.now）。与 TurnRunner/AgentLoop 的 now 注入保持一致。 */
  now?: () => number;
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
  /**
   * 待触发 onPending 的挂起索引：processMessage 挂起后先入队，待宿主确认
   * 转录写入成功（flushPending）才触发 onPending；写入失败（cancelPending）
   * 则撤销挂起——避免审批端感知到未入库的消息。
   */
  private readonly unflushed = new Set<number>();
  private nextIndex = 0;
  private readonly options: PatentOutputGateOptions;

  constructor(options?: PatentOutputGateOptions) {
    this.options = options ?? {};
  }

  /** 注入时钟（毫秒时间戳）；未配置时回退 Date.now。 */
  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * 处理一条待持久化的消息；返回写库用消息与是否挂起。context 为消息所属会话/轮次
   * （记录进挂起条目供审批 UI 定位）。context.skipApproval=true 时审批词命中不挂起
   * （needsApproval=false，质量处理照常）：用于重放已入库消息的场景（如压缩摘要），
   * 避免已审批内容重复挂起产生悬空审批。
   */
  processMessage(
    message: CanonicalMessage,
    context?: { sessionId?: string; turnId?: string; skipApproval?: boolean },
  ): ProcessedMessageResult {
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

    // 第二段：规则驱动门禁（可选）。关键词门禁产物作为输入，规则 warn 追加在关键词处理后；
    // block/review 命中与关键词审批命中同走挂起审批（D3 两段式串接，不合并两套语义）。
    const ruleResult = this.options.ruleGate?.process(info.text);
    const finalText = ruleResult?.text ?? info.text;
    // info.text 同步为最终入库文本（含规则 warn 追加），保持门禁判定与入库内容一致
    const mergedInfo: QualityGateResult = ruleResult === undefined ? info : { ...info, text: finalText };

    const processed = finalText === text ? message : replaceLastTextBlock(message, finalText);

    const needsApproval = mergedInfo.needsApproval || (ruleResult?.needsApproval ?? false);
    if (needsApproval && this.options.onPending && context?.skipApproval !== true) {
      const maxPending = this.options.maxPending ?? 100;
      if (this.pending.size >= maxPending) {
        // 队列已满：放弃挂起、直接入库（fail-open，保证用户可见回复不丢失；
        // 风险内容仍带免责声明/存疑提示。security 权衡已记录：严格合规场景
        // 应提高 maxPending 并确保审批端及时消费，或改为 fail-closed 拒绝输出）。
        console.warn(`[PatentOutputGate] 挂起队列已满（${maxPending}），审批词消息直接入库`);
        return { message: processed, needsApproval: false, info: mergedInfo };
      }
      const index = this.nextIndex;
      this.nextIndex += 1;
      const pending: PendingPatentMessage = {
        index,
        message,
        processed,
        info: mergedInfo,
        ruleViolations: ruleResult?.violations,
        sessionId: context?.sessionId,
        turnId: context?.turnId,
        createdAt: this.now(),
      };
      this.pending.set(index, pending);
      // onPending 不在挂起时立即触发：等待宿主转录写入确认后由 flushPending 触发
      // （D1：避免写入失败时审批端感知到悬空挂起条目；restore() 语义保留给会话恢复）。
      this.unflushed.add(index);
      return { message: processed, needsApproval: true, pendingIndex: index, info: mergedInfo };
    }

    return { message: processed, needsApproval: false, info: mergedInfo };
  }

  /**
   * 转录写入成功后调用：触发 onPending 让审批端感知挂起条目（D1——onPending
   * 延迟到消息确认入库后触发，避免写入失败时出现悬空挂起）。
   */
  flushPending(index: number): void {
    if (!this.unflushed.delete(index)) return;
    const pending = this.pending.get(index);
    if (pending) this.safeInvoke(this.options.onPending, pending);
  }

  /**
   * 转录写入失败时调用：撤销挂起条目（消息未入库，无审批意义；D1 配套方法）。
   */
  cancelPending(index: number): void {
    if (!this.unflushed.delete(index)) return;
    this.pending.delete(index);
  }

  /**
   * 审批通过：取出并移除挂起消息（消息已在挂起时入库，此处仅完成流程控制；触发 onApproved）。
   * 跨会话守卫 fail-closed：条目记录过 sessionId 时必须严格匹配——不传 sessionId 的
   * 裸审批调用同样拒绝；旧条目（无 sessionId）因无法核对而放行（兼容存量数据）。
   * TTL 过期条目不可审批（pruneExpired 仅在新消息触发时清理，此处兜底）。
   * 通过后写入审计记录（verdict=adopted）。
   */
  approve(index: number, sessionId?: string): PendingPatentMessage | undefined {
    const pending = this.pending.get(index);
    if (!pending) return undefined;
    if (pending.sessionId !== undefined && sessionId !== pending.sessionId) {
      return undefined;
    }
    if (this.isExpired(pending)) {
      this.pending.delete(index);
      this.unflushed.delete(index);
      console.warn(`[PatentOutputGate] 挂起消息 ${index} 超过 TTL 未审批，拒绝审批`);
      return undefined;
    }
    this.pending.delete(index);
    this.unflushed.delete(index);
    this.recordApproval(pending, { verdict: "adopted" });
    return pending;
  }

  /** 审批通过且写库成功：触发 onApproved（语义 = 已持久化）。 */
  notifyCommitted(pending: PendingPatentMessage): void {
    this.safeInvoke(this.options.onApproved, pending);
  }

  /**
   * 审批拒绝：丢弃挂起消息。跨会话守卫与 TTL 检查同 approve（fail-closed）。
   * feedback 可选（人工拒绝理由，写入审计）。拒绝后写入审计记录（verdict=rejected）。
   */
  reject(index: number, sessionId?: string, feedback?: string): boolean {
    const pending = this.pending.get(index);
    if (!pending) return false;
    if (pending.sessionId !== undefined && sessionId !== pending.sessionId) {
      return false;
    }
    if (this.isExpired(pending)) {
      this.pending.delete(index);
      this.unflushed.delete(index);
      console.warn(`[PatentOutputGate] 挂起消息 ${index} 超过 TTL 未审批，拒绝审批`);
      return false;
    }
    this.pending.delete(index);
    this.unflushed.delete(index);
    this.recordApproval(pending, { verdict: "rejected", feedback });
    this.safeInvoke(this.options.onRejected, pending);
    return true;
  }

  /** 审计留痕 + 决策反馈回流（approve/reject 时调用；store/回调未配置时零开销，不阻塞流程）。 */
  private recordApproval(
    pending: PendingPatentMessage,
    decision: { verdict: "adopted" | "modified" | "rejected"; modifiedOutput?: string; feedback?: string },
  ): void {
    const record = createApprovalRecord({
      pendingIndex: pending.index,
      sessionId: pending.sessionId,
      turnId: pending.turnId,
      triggerKeyword: pending.info.approvalKeywordsHit[0] ?? pending.ruleViolations?.[0]?.ruleId ?? "unknown",
      originalOutputPreview: extractMessageText(pending.message),
      verdict: decision.verdict,
      ...(decision.modifiedOutput !== undefined ? { modifiedOutput: decision.modifiedOutput } : {}),
      ...(decision.feedback !== undefined ? { feedback: decision.feedback } : {}),
      now: this.options.now !== undefined ? () => new Date(this.now()) : undefined,
    });
    const store = this.options.approvalStore;
    if (store) {
      this.swallowRejection(store.saveRecord(record), err => {
        console.error("[PatentOutputGate] 审批审计写入失败:", err);
      });
    }
    // 决策反馈回流（P2-4）：modified/rejected 时交给宿主接线（写 feedback 文件等），
    // 不依赖 approvalStore 是否配置。
    if (decision.verdict !== "adopted") {
      const sink = this.options.onDecisionFeedback;
      if (sink) {
        try {
          this.swallowRejection(sink(record), err => {
            console.error("[PatentOutputGate] 决策反馈回调失败:", err);
          });
        } catch (err) {
          console.error("[PatentOutputGate] 决策反馈回调失败:", err);
        }
      }
    }
  }

  /**
   * 宿主会话恢复钩子：重新注册挂起条目（不直接触发 onPending——与 D1 协议一致，
   * onPending 仅在写入确认后经 flushPending 触发；此处恢复的条目宿主确认写入后
   * 同样走 flushPending）。避免恢复流程重新引入悬空挂起。
   */
  restore(pending: PendingPatentMessage): void {
    if (!this.pending.has(pending.index)) {
      this.pending.set(pending.index, pending);
      this.unflushed.add(pending.index);
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
    for (const [index, pending] of this.pending) {
      if (this.isExpired(pending)) {
        this.pending.delete(index);
        this.unflushed.delete(index);
        console.warn(`[PatentOutputGate] 挂起消息 ${index} 超过 TTL（${ttl}ms）未审批，已清理`);
      }
    }
  }

  /** 是否超过挂起 TTL（pendingTtlMs <= 0 表示不过期）。approve/reject/pruneExpired 共用。 */
  private isExpired(pending: PendingPatentMessage): boolean {
    const ttl = this.options.pendingTtlMs ?? 0;
    if (ttl <= 0) return false;
    return this.now() - pending.createdAt > ttl;
  }

  private shouldProcess(message: CanonicalMessage): boolean {
    if (message.role !== "assistant") return false;
    // 含工具调用/结果的消息不是面向用户的答案，跳过（与 Mady citationGate 一致）
    if (message.content.some(block => block.type === "tool_call" || block.type === "tool_result")) {
      return false;
    }
    return extractMessageText(message).trim().length > 0;
  }

  /** 吞掉回调/写库返回的 rejected promise（避免 unhandled rejection）；同步抛错由调用方 try/catch 处理。 */
  private swallowRejection(result: unknown, onError: (err: unknown) => void): void {
    if (result && typeof (result as Promise<void>).catch === "function") {
      (result as Promise<void>).catch(onError);
    }
  }

  /** 安全调用回调：吞掉同步抛错与 rejected promise，避免 unhandled rejection。 */
  private safeInvoke(
    callback: ((pending: PendingPatentMessage) => void | Promise<void>) | undefined,
    pending: PendingPatentMessage,
  ): void {
    if (!callback) return;
    try {
      this.swallowRejection(callback(pending), err => {
        console.error("[PatentOutputGate] callback failed:", err);
      });
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
