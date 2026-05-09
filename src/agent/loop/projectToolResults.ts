import type { CanonicalMessage } from "../../model/index.js";
import { toCanonicalToolResultBlock, type PilotDeckToolResult } from "../../tool/index.js";

export function projectToolResults(results: PilotDeckToolResult[]): CanonicalMessage {
  return {
    role: "user",
    content: results.map(toCanonicalToolResultBlock),
  };
}
