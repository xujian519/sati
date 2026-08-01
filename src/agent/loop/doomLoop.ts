/**
 * DoomLoop 死循环检测（移植自 Mady doomloop/doomloop.go 设计）。
 *
 * 六个正交无锁检测器 + 一个串行化协调器，从六个维度覆盖 Agent 主循环的
 * 死循环形态：
 *   - toolCallLoop     窗口内同参工具调用完全重复（文本响应时清空窗口）
 *   - textRepetition   最近 N 轮输出末尾逐字复读
 *   - cycle            工具名历史中的周期模式（A→B→A→B）
 *   - emptyResult      连续 N 次工具结果全空
 *   - circuitBreaker   单 turn 工具调用总量超限（全局兜底）
 *   - compactionBreaker 连续只输出摘要/总结且不调工具（压缩空转）
 *
 * 与 AgentLoop 既有 detectRepeatedToolFailure（仅覆盖"失败签名重复"）互补：
 * 本模块覆盖更广的六维形态，是"何时该停"的熔断层；fatal 默认关闭（纯观测），
 * 开启后命中 Fatal 信号即终止当前 turn（结构化错误，可恢复诊断）。
 */

export type DoomLoopDetectorId =
  | "toolCallLoop"
  | "textRepetition"
  | "cycle"
  | "emptyResult"
  | "circuitBreaker"
  | "compactionBreaker";

export type ModelCallObservation = {
  /** 模型输出文本（无文本时为空字符串） */
  text: string;
};

export type ToolCallObservation = {
  name: string;
  args: unknown;
  /** 工具结果文本（失败/无结果时为空字符串） */
  result: string;
};

export type DoomLoopSignal = {
  detector: DoomLoopDetectorId;
  reason: string;
  turn: number;
  /** true = 应立即终止当前 turn（受 DoomLoopOptions.fatal 开关约束） */
  fatal: boolean;
};

/** 协调器传给检测器的只读上下文快照。 */
export type DetectorContext = {
  modelCalls: ModelCallObservation[];
  toolCalls: ToolCallObservation[];
  totalToolCalls: number;
};

export interface DoomLoopDetector {
  readonly id: DoomLoopDetectorId;
  recordModelCall(ctx: DetectorContext, obs: ModelCallObservation): DoomLoopSignal | undefined;
  recordToolResult(ctx: DetectorContext, obs: ToolCallObservation): DoomLoopSignal | undefined;
  reset(): void;
}

export type DoomLoopOptions = {
  /** 单 turn 工具调用总量上限（circuitBreaker，默认 30） */
  maxToolCallsPerTurn?: number;
  /** 命中信号是否标记 fatal（默认 false = 纯观测，仅发射事件） */
  fatal?: boolean;
};

export function doomLoopSignal(
  detector: DoomLoopDetectorId,
  reason: string,
  turn: number,
  fatal: boolean,
): DoomLoopSignal {
  return { detector, reason, turn, fatal };
}

// ---------------------------------------------------------------------------
// 检测器 1/6：toolCallLoop —— 同参工具调用完全重复
// ---------------------------------------------------------------------------

export class ToolCallLoopDetector implements DoomLoopDetector {
  readonly id = "toolCallLoop" as const;
  private window: Array<{ key: string; turn: number }> = [];

  constructor(private readonly maxRepeats = 3) {}

  recordModelCall(ctx: DetectorContext, obs: ModelCallObservation): DoomLoopSignal | undefined {
    void ctx;
    // 模型输出了文本 = 换话题：清空同参窗口。
    if (obs.text.trim().length > 0) {
      this.window = [];
    }
    return undefined;
  }

  recordToolResult(_ctx: DetectorContext, obs: ToolCallObservation): DoomLoopSignal | undefined {
    const key = toolCallKey(obs);
    this.window.push({ key, turn: _ctx.totalToolCalls });
    // 保留最近 maxRepeats 次用于连续判定
    if (this.window.length > this.maxRepeats) {
      this.window.shift();
    }
    if (this.window.length === this.maxRepeats && this.window.every(w => w.key === key)) {
      this.window = [];
      return doomLoopSignal(
        this.id,
        `连续 ${this.maxRepeats} 次完全相同的工具调用: ${obs.name}`,
        _ctx.totalToolCalls,
        false,
      );
    }
    return undefined;
  }

  reset(): void {
    this.window = [];
  }
}

// ---------------------------------------------------------------------------
// 检测器 2/6：textRepetition —— 输出末尾逐字复读
// ---------------------------------------------------------------------------

export class TextRepetitionDetector implements DoomLoopDetector {
  readonly id = "textRepetition" as const;
  private lastFingerprints: string[] = [];

  constructor(
    private readonly maxRepeats = 3,
    private readonly tailChars = 100,
  ) {}

  recordModelCall(_ctx: DetectorContext, obs: ModelCallObservation): DoomLoopSignal | undefined {
    const text = obs.text.trim();
    if (text.length === 0) {
      this.lastFingerprints = [];
      return undefined;
    }
    const fingerprint = text.slice(-this.tailChars);
    this.lastFingerprints.push(fingerprint);
    if (this.lastFingerprints.length > this.maxRepeats) {
      this.lastFingerprints.shift();
    }
    if (this.lastFingerprints.length === this.maxRepeats && this.lastFingerprints.every(fp => fp === fingerprint)) {
      this.lastFingerprints = [];
      return doomLoopSignal(
        this.id,
        `连续 ${this.maxRepeats} 轮输出末尾逐字相同（疑似复读）`,
        _ctx.totalToolCalls,
        false,
      );
    }
    return undefined;
  }

  recordToolResult(): DoomLoopSignal | undefined {
    return undefined;
  }

  reset(): void {
    this.lastFingerprints = [];
  }
}

// ---------------------------------------------------------------------------
// 检测器 3/6：cycle —— 工具名历史周期模式
// ---------------------------------------------------------------------------

export class CycleDetector implements DoomLoopDetector {
  readonly id = "cycle" as const;
  private history: string[] = [];
  /** 允许检测的最大周期长度 */
  private readonly maxCycleLen = 4;
  /** 周期重复次数阈值 */
  private readonly minRepeats = 2;

  recordModelCall(_ctx: DetectorContext, obs: ModelCallObservation): DoomLoopSignal | undefined {
    // 输出文本视为话题切换：清空周期历史。
    if (obs.text.trim().length > 0) {
      this.history = [];
    }
    return undefined;
  }

  recordToolResult(_ctx: DetectorContext, obs: ToolCallObservation): DoomLoopSignal | undefined {
    this.history.push(obs.name);
    // 只保留最近 maxCycleLen * (minRepeats + 1) 个名称
    const cap = this.maxCycleLen * (this.minRepeats + 1);
    if (this.history.length > cap) {
      this.history.splice(0, this.history.length - cap);
    }
    for (let len = 1; len <= this.maxCycleLen; len += 1) {
      if (hasRepeatingTailPattern(this.history, len, this.minRepeats)) {
        const patternText = this.history.slice(-len * this.minRepeats).join(" → ");
        this.history = [];
        return doomLoopSignal(
          this.id,
          `工具调用出现周期模式（长度 ${len}，重复 ${this.minRepeats}+ 次）: ${patternText}`,
          _ctx.totalToolCalls,
          false,
        );
      }
    }
    return undefined;
  }

  reset(): void {
    this.history = [];
  }
}

// ---------------------------------------------------------------------------
// 检测器 4/6：emptyResult —— 连续空结果
// ---------------------------------------------------------------------------

export class EmptyResultDetector implements DoomLoopDetector {
  readonly id = "emptyResult" as const;
  private consecutive = 0;

  constructor(private readonly maxEmpty = 4) {}

  recordModelCall(): DoomLoopSignal | undefined {
    return undefined;
  }

  recordToolResult(_ctx: DetectorContext, obs: ToolCallObservation): DoomLoopSignal | undefined {
    if (obs.result.trim().length === 0) {
      this.consecutive += 1;
      if (this.consecutive >= this.maxEmpty) {
        this.consecutive = 0;
        return doomLoopSignal(
          this.id,
          `连续 ${this.maxEmpty} 次工具结果为空（${obs.name}）`,
          _ctx.totalToolCalls,
          false,
        );
      }
    } else {
      this.consecutive = 0;
    }
    return undefined;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

// ---------------------------------------------------------------------------
// 检测器 5/6：circuitBreaker —— 单 turn 工具调用总量
// ---------------------------------------------------------------------------

export class CircuitBreakerDetector implements DoomLoopDetector {
  readonly id = "circuitBreaker" as const;

  constructor(private readonly maxToolCalls: number) {}

  recordModelCall(): DoomLoopSignal | undefined {
    return undefined;
  }

  recordToolResult(_ctx: DetectorContext, obs: ToolCallObservation): DoomLoopSignal | undefined {
    if (_ctx.totalToolCalls > this.maxToolCalls) {
      return doomLoopSignal(
        this.id,
        `单 turn 工具调用总量超过上限 ${this.maxToolCalls}（当前 ${_ctx.totalToolCalls}，最近: ${obs.name}）`,
        _ctx.totalToolCalls,
        false,
      );
    }
    return undefined;
  }

  reset(): void {}
}

// ---------------------------------------------------------------------------
// 检测器 6/6：compactionBreaker —— 压缩空转（只输出摘要不调工具）
// ---------------------------------------------------------------------------

const SUMMARY_MARKERS = ["总结", "摘要", "小结", "概括", "汇总", "Summary", "summary", "综上", "综上所述", "结论"];

export class CompactionBreakerDetector implements DoomLoopDetector {
  readonly id = "compactionBreaker" as const;
  private consecutive = 0;

  constructor(private readonly maxIdle = 3) {}

  recordModelCall(_ctx: DetectorContext, obs: ModelCallObservation): DoomLoopSignal | undefined {
    const text = obs.text.trim();
    const isSummary = text.length > 0 && SUMMARY_MARKERS.some(m => text.includes(m));
    if (isSummary) {
      this.consecutive += 1;
      if (this.consecutive >= this.maxIdle) {
        this.consecutive = 0;
        return doomLoopSignal(
          this.id,
          `连续 ${this.maxIdle} 轮仅输出摘要/总结且未调用任何工具（压缩空转）`,
          _ctx.totalToolCalls,
          false,
        );
      }
    } else {
      this.consecutive = 0;
    }
    return undefined;
  }

  recordToolResult(): DoomLoopSignal | undefined {
    // 调用工具即打破空转。
    this.consecutive = 0;
    return undefined;
  }

  reset(): void {
    this.consecutive = 0;
  }
}

// ---------------------------------------------------------------------------
// 协调器
// ---------------------------------------------------------------------------

export class DoomLoop {
  private readonly detectors: DoomLoopDetector[];
  private readonly fatalEnabled: boolean;
  private readonly maxToolCallsPerTurn: number;
  private modelCalls: ModelCallObservation[] = [];
  private toolCalls: ToolCallObservation[] = [];
  private totalToolCalls = 0;
  private currentTurn = 1;
  private pendingSignals: DoomLoopSignal[] = [];

  constructor(detectors?: DoomLoopDetector[], options: DoomLoopOptions = {}) {
    const maxToolCalls = options.maxToolCallsPerTurn ?? 30;
    this.maxToolCallsPerTurn = maxToolCalls;
    this.fatalEnabled = options.fatal ?? false;
    this.detectors =
      detectors ??
      defaultDoomLoopDetectors({
        maxToolCallsPerTurn: maxToolCalls,
      });
  }

  /** 每 turn 开始调用：重置检测器窗口与观测历史。 */
  reset(turn: number): void {
    this.currentTurn = turn;
    this.modelCalls = [];
    this.toolCalls = [];
    this.totalToolCalls = 0;
    this.pendingSignals = [];
    for (const d of this.detectors) {
      d.reset();
    }
  }

  /** 记录一次模型输出；返回新产生的信号（fatal 受开关约束）。 */
  recordModelCall(obs: ModelCallObservation): DoomLoopSignal[] {
    this.modelCalls.push(obs);
    return this.sweep(detector => detector.recordModelCall(this.ctx(), obs));
  }

  /** 记录一次工具执行结果；返回新产生的信号。 */
  recordToolResult(obs: ToolCallObservation): DoomLoopSignal[] {
    this.totalToolCalls += 1;
    this.toolCalls.push(obs);
    return this.sweep(detector => detector.recordToolResult(this.ctx(), obs));
  }

  private ctx(): DetectorContext {
    return {
      modelCalls: this.modelCalls,
      toolCalls: this.toolCalls,
      totalToolCalls: this.totalToolCalls,
    };
  }

  private sweep(visit: (d: DoomLoopDetector) => DoomLoopSignal | undefined): DoomLoopSignal[] {
    const signals: DoomLoopSignal[] = [];
    for (const detector of this.detectors) {
      const signal = visit(detector);
      if (signal) {
        // fatal 开关开启时，所有命中信号升级为 fatal（熔断层语义）；
        // 关闭时纯观测（fatal 恒 false，仅发射事件供诊断）。
        const effective: DoomLoopSignal = { ...signal, fatal: this.fatalEnabled };
        signals.push(effective);
        this.pendingSignals.push(effective);
      }
    }
    return signals;
  }

  /** 当前 turn 是否已产生 Fatal 信号。 */
  hasFatal(): boolean {
    return this.pendingSignals.some(s => s.fatal);
  }

  /** 取最近一次 Fatal 信号（用于终止原因）。 */
  fatalSignal(): DoomLoopSignal | undefined {
    return [...this.pendingSignals].reverse().find(s => s.fatal);
  }

  /** 全部信号（供事件发射/诊断）。 */
  signals(): DoomLoopSignal[] {
    return [...this.pendingSignals];
  }

  maxToolCalls(): number {
    return this.maxToolCallsPerTurn;
  }

  currentTurnNumber(): number {
    return this.currentTurn;
  }
}

export function defaultDoomLoopDetectors(options: { maxToolCallsPerTurn?: number } = {}): DoomLoopDetector[] {
  const maxToolCalls = options.maxToolCallsPerTurn ?? 30;
  return [
    new ToolCallLoopDetector(),
    new TextRepetitionDetector(),
    new CycleDetector(),
    new EmptyResultDetector(),
    new CircuitBreakerDetector(maxToolCalls),
    new CompactionBreakerDetector(),
  ];
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 工具调用指纹：name + 稳定序列化的 args。 */
export function toolCallKey(obs: Pick<ToolCallObservation, "name" | "args">): string {
  let argsText: string;
  try {
    argsText = JSON.stringify(obs.args ?? {});
  } catch {
    argsText = String(obs.args ?? "");
  }
  return `${obs.name}:${argsText}`;
}

/** 历史尾部是否呈周期模式（长度为 len 的块重复 minRepeats 次）。 */
function hasRepeatingTailPattern(history: string[], len: number, minRepeats: number): boolean {
  const total = len * minRepeats;
  if (history.length < total) return false;
  const tail = history.slice(-total);
  const first = tail.slice(0, len);
  for (let i = 0; i < minRepeats; i += 1) {
    const block = tail.slice(i * len, (i + 1) * len);
    for (let j = 0; j < len; j += 1) {
      if (block[j] !== first[j]) return false;
    }
  }
  return true;
}
