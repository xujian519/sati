import type { CanonicalMessage } from "../../model/index.js";
import { toCanonicalToolResultBlock, type PolitDeckToolResult } from "../../tool/index.js";

export function projectToolResults(results: PolitDeckToolResult[]): CanonicalMessage {
  return {
    role: "user",
    content: results.map(toCanonicalToolResultBlock),
  };
}
