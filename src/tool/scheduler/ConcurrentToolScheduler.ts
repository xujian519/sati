import type { SatiToolResult } from "../protocol/result.js";
import type { SatiToolCall, SatiToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { ToolRegistry } from "../registry/ToolRegistry.js";
import type { SatiToolScheduler } from "./ToolScheduler.js";

export type ConcurrentToolSchedulerOptions = {
  /** 单个批次内同时执行的上限。默认 4。 */
  maxConcurrency?: number;
};

/**
 * 并发安全调用走有界 worker 池；独占调用作为屏障，先排空在跑的调用再串行执行。
 * 结果始终按原始调用顺序回填。
 *
 * 有界是必要的：单轮模型可能一次性排出几十个只读调用，无上限 `Promise.all`
 * 会把文件句柄、网络连接与工具内部资源同时打满。
 */
export class ConcurrentToolScheduler implements SatiToolScheduler {
  private readonly maxConcurrency: number;

  constructor(
    private readonly runtime: ToolRuntime,
    private readonly registry: ToolRegistry,
    options: ConcurrentToolSchedulerOptions = {},
  ) {
    this.maxConcurrency = options.maxConcurrency ?? 4;
    if (!Number.isSafeInteger(this.maxConcurrency) || this.maxConcurrency < 1) {
      throw new RangeError("maxConcurrency must be a positive safe integer.");
    }
  }

  async executeAll(calls: SatiToolCall[], context: SatiToolRuntimeContext): Promise<SatiToolResult[]> {
    if (calls.length === 0) {
      return [];
    }
    if (calls.length === 1) {
      return [await this.runtime.execute(calls[0], context)];
    }

    const results = new Array<SatiToolResult>(calls.length);
    const active = new Set<Promise<void>>();
    // 用独立对象承载失败原因：被拒绝的 Promise 本身也可能是 undefined。
    let failure: { reason: unknown } | undefined;
    const throwIfFailed = (): void => {
      if (failure) {
        throw failure.reason;
      }
    };
    const start = (index: number): void => {
      const execution = (async () => {
        try {
          results[index] = await this.runtime.execute(calls[index], context, {
            requireConcurrencySafe: this.maxConcurrency > 1,
          });
        } catch (reason) {
          failure ??= { reason };
        }
      })();
      const tracked = execution.finally(() => {
        active.delete(tracked);
      });
      active.add(tracked);
    };

    try {
      for (let index = 0; index < calls.length; index++) {
        if (active.size >= this.maxConcurrency) {
          await Promise.race(active);
        }
        throwIfFailed();
        const call = calls[index];
        if (context.abortSignal?.aborted || !this.isConcurrencySafe(call)) {
          // 独占调用是屏障：先等在跑的并发调用收尾，再单独执行。
          await Promise.all(active);
          throwIfFailed();
          results[index] = await this.runtime.execute(call, context);
        } else {
          start(index);
        }
      }
      await Promise.all(active);
      throwIfFailed();
      return results;
    } finally {
      // 取消或意外失败都不能留下已启动但未收尾的调用。
      await Promise.all(active);
    }
  }

  private isConcurrencySafe(call: SatiToolCall): boolean {
    try {
      return this.registry.get(call.name)?.isConcurrencySafe(call.input) ?? false;
    } catch {
      // 判定函数抛错时按独占处理：宁可串行，也不把未知安全性当并发安全。
      return false;
    }
  }
}
