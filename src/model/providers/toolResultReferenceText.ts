import type { CanonicalContentBlock } from "../protocol/canonical.js";

type ToolResultReferenceBlock = Extract<CanonicalContentBlock, { type: "tool_result_reference" }>;

export function formatToolResultReferenceText(block: ToolResultReferenceBlock): string {
  if (!block.hasMore) {
    return block.preview;
  }
  const filePath = block.readFilePath ?? block.path;
  return block.preview
    + `\n\n[Tool result preview only: original ${block.originalBytes} bytes. Full output was saved at: ${filePath}. `
    + `To inspect it, call read_file({ file_path: "${filePath}", offset: 1, limit: 100 }). `
    + "If the task depends on complete lists, counts, search candidates, evidence checks, or long page content, read the persisted result or search within it before concluding.]";
}
