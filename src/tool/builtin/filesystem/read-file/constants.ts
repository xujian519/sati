export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_TOKENS = 25_000;
export const LARGE_TEXT_AUTO_PAGE_BYTES = 200_000;
export const SAFE_TEXT_BUDGET_BYTES = 80_000;
export const OVERSIZED_LINE_PREVIEW_BYTES = 20_000;
export const DEFAULT_LARGE_TEXT_PREVIEW_LINES = 2_000;
export const MAX_PDF_PAGES_PER_REQUEST = 20;
export const PDF_AT_MENTION_INLINE_THRESHOLD = 10;
export const PDF_EXTRACT_SIZE_THRESHOLD = 3 * 1024 * 1024;
export const FILE_UNCHANGED_STUB =
  "File unchanged since the last read. Refer to the earlier read_file result instead of re-reading it.";
