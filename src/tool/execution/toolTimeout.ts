/**
 * Registry 级工具超时强制（阶段四 T6.1）。
 *
 * 工具在 SatiToolDefinition.timeoutMs 自报预算（零配置），调度层在
 * ToolRuntime.execute 把 deadline 熔合进执行 signal；到期后按 signal 归一为
 * 结构化 TOOL_TIMEOUT。合作式语义：忽略 signal 的工具无法被硬杀，仅能在
 * 其返回后由调用方判定超时。
 */

/**
 * 把 deadline 熔合进既有执行 signal。
 *
 * @param abortSignal - 调用方既有取消信号（可能缺省）。
 * @param timeoutMs - 工具自报的预算（毫秒）。
 * @returns 熔合后的信号：任一来源触发即中止。
 */
export function fuseToolTimeout(abortSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return abortSignal === undefined ? deadline : AbortSignal.any([abortSignal, deadline]);
}

/**
 * 判定熔合信号的中止是否由超时触发（而非调用方取消）。
 *
 * @param fused - 熔合后的信号。
 * @param parent - 熔合前的调用方信号。
 * @returns 仅当熔合信号已中止且调用方信号未中止时为 true。
 */
export function isToolTimeout(fused: AbortSignal | undefined, parent: AbortSignal | undefined): boolean {
  return fused !== undefined && fused.aborted && (parent === undefined || !parent.aborted);
}
