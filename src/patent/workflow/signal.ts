/**
 * src/patent/workflow — 一致性回退信号判定（纯函数）。
 *
 * 从 workflow.ts 拆出（A7 轮次 2）：信号正则编译/缓存 + 触发判定，
 * 独立可单测（否定词窗口、句界排除、g-flag lastIndex 重置语义锁定）。
 */

import type { WorkflowStage } from "./types.js";

/**
 * 信号触发判定：匹配位置前窗口内出现否定词（不/未/无/没，无句界分隔）
 * 时视为否定性表述（"未发现不一致""不缺少任何特征"），不触发回退。
 */
export function signalMatches(text: string, signal: RegExp): boolean {
  let match: RegExpExecArray | null;
  const RE = /[不未无没]/;
  signal.lastIndex = 0; // 带 g 标志的正则跨调用保留 lastIndex：回退重入前必须重置，否则 exec 直接返回 null
  while ((match = signal.exec(text)) !== null) {
    const start = Math.max(0, match.index - 12);
    const before = text.slice(start, match.index);
    if (!before.includes("。") && !before.includes("；") && !before.includes(";") && !RE.test(before)) {
      return true;
    }
    if (match[0].length === 0) signal.lastIndex += 1;
  }
  return false;
}

/** 编译信号正则（g 标志必需：signalMatches 用 exec 遍历全部匹配位置，无 g 时 exec 每次从头匹配 → 死循环）。 */
export function compileSignal(pattern: string): RegExp {
  return new RegExp(pattern, "gi");
}

/** 带缓存的信号获取（按阶段 id 缓存，避免每次执行/回退重新编译）。 */
export function signalFor(stage: WorkflowStage, cache: Map<string, RegExp>): RegExp | undefined {
  if (stage.retry === undefined) return undefined;
  const cached = cache.get(stage.id);
  if (cached !== undefined) return cached;
  const compiled = compileSignal(stage.retry.whenOutputMatches);
  cache.set(stage.id, compiled);
  return compiled;
}
