import type { PolitDeckToolResult } from "../protocol/result.js";
import type { PolitDeckToolCall, PolitDeckToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { PolitDeckToolScheduler } from "./ToolScheduler.js";

export class SequentialToolScheduler implements PolitDeckToolScheduler {
  constructor(private readonly runtime: ToolRuntime) {}

  async executeAll(
    calls: PolitDeckToolCall[],
    context: PolitDeckToolRuntimeContext,
  ): Promise<PolitDeckToolResult[]> {
    const results: PolitDeckToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runtime.execute(call, context));
    }
    return results;
  }
}
