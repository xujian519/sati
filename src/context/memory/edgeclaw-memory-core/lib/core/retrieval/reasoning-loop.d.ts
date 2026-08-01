import type { IndexingSettings, MemoryMessage, RetrievalResult, RecallMode } from "../types.js";
import { LlmMemoryExtractor } from "../skills/llm-extraction.js";
import { MemoryRepository } from "../storage/sqlite.js";
export interface RetrievalOptions {
    retrievalMode?: "auto" | "explicit";
    recentMessages?: MemoryMessage[];
    workspaceHint?: string;
}
export interface RetrievalRuntimeOptions {
    getSettings?: () => IndexingSettings;
    isBackgroundBusy?: () => boolean;
    logger?: {
        warn?: (...args: unknown[]) => void;
    };
    /**
     * 可选语义召回路：embedding 检索记忆正文，返回按相关度降序的
     * 相对路径候选。返回的命中会与 manifest 做 RRF 融合后交给
     * LLM 选择（候选增强，不替换现有决策链）。未配置时为 undefined。
     */
    semanticSearch?: (query: string, limit: number) => Promise<Array<{
        relativePath: string;
        score: number;
    }>>;
}
export interface RetrievalRuntimeStats {
    lastRecallMs: number;
    recallTimeouts: number;
    lastRecallMode: RecallMode;
    lastRecallPath: "auto" | "explicit" | "shadow";
    lastRecallInjected: boolean;
    lastRecallCacheHit: boolean;
}
export declare class ReasoningRetriever {
    private readonly repository;
    private readonly extractor;
    private readonly options;
    private readonly recallCache;
    private runtimeStats;
    constructor(repository: MemoryRepository, extractor: LlmMemoryExtractor, options?: RetrievalRuntimeOptions);
    getRuntimeStats(): RetrievalRuntimeStats;
    /** 运行时注入/替换语义召回路（服务构造后由外部装配，避免构造期循环依赖）。 */
    setSemanticSearch(fn: RetrievalRuntimeOptions["semanticSearch"]): void;
    resetTransientState(): void;
    retrieve(query: string, options?: RetrievalOptions): Promise<RetrievalResult>;
}
