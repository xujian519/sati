import type { CanonicalContentBlock } from "../protocol/canonical.js";

type ToolResultReferenceBlock = Extract<CanonicalContentBlock, { type: "tool_result_reference" }>;

export function formatToolResultReferenceText(block: ToolResultReferenceBlock): string {
  if (!block.hasMore) {
    return block.preview;
  }
  const filePath = block.readFilePath ?? block.path;
  return block.preview
    + `\n\n[Tool result preview only: original ${block.originalBytes} bytes. Full output was saved at: ${filePath}. `
    + `To inspect it, call read_file({ file_path: "${filePath}", offset: 1, limit: 200 }). `
    + "If the task depends on complete lists, counts, evidence checks, or long page content, read the persisted result before concluding.]";
}
