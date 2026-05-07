import type { PolitDeckToolResult } from "../protocol/result.js";
import type { PolitDeckToolCall, PolitDeckToolRuntimeContext } from "../protocol/types.js";

export type PolitDeckToolScheduler = {
  executeAll(calls: PolitDeckToolCall[], context: PolitDeckToolRuntimeContext): Promise<PolitDeckToolResult[]>;
};
