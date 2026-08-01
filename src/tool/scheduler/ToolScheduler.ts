import type { SatiToolResult } from "../protocol/result.js";
import type { SatiToolCall, SatiToolRuntimeContext } from "../protocol/types.js";

export type SatiToolScheduler = {
  executeAll(calls: SatiToolCall[], context: SatiToolRuntimeContext): Promise<SatiToolResult[]>;
};
