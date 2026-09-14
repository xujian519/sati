export const MAX_PATENTS = 50;
export const MAX_OUTPUT_BYTES = 500_000;

/** 默认整体超时的推算参数：每篇 25s，下限 60s，上限 180s（inputSchema 硬上限 300s 留给用户显式指定）。 */
export const PER_PATENT_TIMEOUT_MS = 25_000;
export const MIN_DEFAULT_TIMEOUT_MS = 60_000;
export const MAX_DEFAULT_TIMEOUT_MS = 180_000;
