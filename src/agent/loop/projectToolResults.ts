import type { CanonicalContentBlock, CanonicalMessage } from "../../model/index.js";
import { toCanonicalToolResultBlock, type PilotDeckToolResult } from "../../tool/index.js";

export function projectToolResults(results: PilotDeckToolResult[]): CanonicalMessage {
  const content: CanonicalContentBlock[] = [];
  for (const result of results) {
    content.push(toCanonicalToolResultBlock(result));
    for (const item of result.content) {
      if (item.type === "image") {
        content.push({
          type: "image",
          source: "base64",
          data: item.data,
          mimeType: item.mimeType,
        });
      }
    }
  }
  return { role: "user", content };
}
