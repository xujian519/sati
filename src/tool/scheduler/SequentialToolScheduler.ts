import type { SatiToolResult } from "../protocol/result.js";
import type { SatiToolCall, SatiToolRuntimeContext } from "../protocol/types.js";
import type { ToolRuntime } from "../execution/ToolRuntime.js";
import type { SatiToolScheduler } from "./ToolScheduler.js";

export class SequentialToolScheduler implements SatiToolScheduler {
  constructor(private readonly runtime: ToolRuntime) {}

  async executeAll(calls: SatiToolCall[], context: SatiToolRuntimeContext): Promise<SatiToolResult[]> {
    const results: SatiToolResult[] = [];
    for (const call of calls) {
      results.push(await this.runtime.execute(call, context));
    }
    return results;
  }
}
