/**
 * 知识系统能力自检（诊断）。
 *
 * 与 assemble.ts 的组装逻辑严格对齐：判定结果反映运行时实际启用的能力，
 * 供启动时输出可读能力清单，避免数据/配置缺失时静默降级。
 */

import type { KnowledgeDbPaths } from "./config.js";
import type { KnowledgeRuntimeStatsSnapshot } from "./shared/knowledge-stats.js";

export type KnowledgeCapabilityStatus = "ready" | "missing" | "disabled";

export type KnowledgeCapability = {
  /** 能力标识（稳定，供程序消费）。 */
  id:
    | "patent-kg"
    | "patent-ipc"
    | "patent-wiki"
    | "legal-fts"
    | "case-law"
    | "semantic-embedding"
    | "semantic-vectors"
    | "rerank"
    | "kg-fts-tokenizer"
    | "wiki-semantic-index";
  /** 人类可读名称。 */
  label: string;
  status: KnowledgeCapabilityStatus;
  /** 缺失/关闭时的配置提示（环境变量名或命令，供诊断文案）。 */
  detail?: string;
};

export type KnowledgeCapabilitiesOptions = {
  /** 是否已配置 embedding 客户端（memory.embedding.enabled）。 */
  embeddingConfigured: boolean;
  /** 是否已配置 rerank 客户端（memory.embedding.rerank）。 */
  rerankConfigured: boolean;
  /**
   * 运行时统计快照（可选）。提供时追加两项运行时能力（KG FTS tokenizer、
   * wiki 语义索引状态），把静默降级（如桌面端 FTS5 缺失回退 LIKE）暴露出来。
   */
  runtime?: KnowledgeRuntimeStatsSnapshot;
};

/** 解析知识系统能力清单（不打开数据库，仅按路径探测与配置判定）。 */
export function resolveKnowledgeCapabilities(
  paths: KnowledgeDbPaths,
  options: KnowledgeCapabilitiesOptions,
): KnowledgeCapability[] {
  const capabilities: KnowledgeCapability[] = [
    {
      id: "patent-kg",
      label: "专利知识图谱",
      status: paths.patentKgDb ? "ready" : "missing",
      detail: paths.patentKgDb ? undefined : "SATI_PATENT_KG_DB",
    },
    {
      // IPC 审查标准随仓库内置（ipc-standards.yaml），恒可用。
      id: "patent-ipc",
      label: "IPC 审查标准",
      status: "ready",
    },
    {
      id: "patent-wiki",
      label: "专利 wiki 卡片",
      status: paths.wikiDir ? "ready" : "missing",
      detail: paths.wikiDir ? undefined : "SATI_WIKI_DIR",
    },
    {
      id: "legal-fts",
      label: "法律法规全文检索",
      status: paths.lawDb ? "ready" : "missing",
      detail: paths.lawDb ? undefined : "SATI_LAW_DB",
    },
    {
      id: "case-law",
      label: "专利判例全文",
      status: paths.caseDb ? "ready" : "missing",
      detail: paths.caseDb ? undefined : "SATI_CASE_DB",
    },
    {
      id: "semantic-embedding",
      label: "语义 embedding",
      status: options.embeddingConfigured ? "ready" : "disabled",
      detail: options.embeddingConfigured ? undefined : "memory.embedding.enabled",
    },
    {
      id: "semantic-vectors",
      label: "离线语义索引",
      status: paths.vectorsDb ? "ready" : "disabled",
      // 未构建时给出重建命令（全量 30-90 分钟），避免"已配 embedding 但无向量"的静默降级
      detail: paths.vectorsDb
        ? undefined
        : "未构建（pnpm tsx scripts/build-knowledge-vectors.ts；产物 vectors.db 供 KG/法条语义召回）",
    },
    {
      id: "rerank",
      label: "重排 rerank",
      status: options.rerankConfigured ? "ready" : "disabled",
      detail: options.rerankConfigured ? undefined : "memory.embedding.rerank",
    },
  ];
  // 运行时能力项：仅在有运行时快照时追加（探测结果来自 provider 打点）。
  const runtime = options.runtime;
  if (runtime && runtime.kgFtsMode !== "unknown") {
    const mode = runtime.kgFtsMode;
    capabilities.push({
      id: "kg-fts-tokenizer",
      label: "KG FTS 分词器",
      status: mode === "like" ? "missing" : "ready",
      detail:
        mode === "trigram"
          ? "trigram"
          : mode === "unicode61"
            ? "unicode61（建议执行 scripts/migrate-kg-fts-trigram.mjs 升级 trigram）"
            : "FTS5 不可用已回退 LIKE（如桌面端捆绑 Node 未编译 FTS5）",
    });
  }
  if (runtime && runtime.wikiSemanticIndex !== "disabled") {
    const state = runtime.wikiSemanticIndex;
    capabilities.push({
      id: "wiki-semantic-index",
      label: "wiki 语义索引",
      status: state === "failed" ? "missing" : "ready",
      detail: state === "warming" ? "预热中" : state === "failed" ? "预热失败（已回退关键词三路）" : undefined,
    });
  }
  return capabilities;
}

/** 格式化为单行紧凑清单（id=status(提示)，供 console 输出）。 */
export function formatKnowledgeCapabilities(capabilities: KnowledgeCapability[]): string {
  return capabilities
    .map(cap => {
      const hint = cap.status === "ready" ? "" : `(${cap.detail ?? "未配置"})`;
      return `${cap.id}=${cap.status}${hint}`;
    })
    .join(" ");
}

export type KnowledgeCapabilityLogger = {
  info: (message: string) => void;
  warn: (message: string) => void;
};

/** 计算并输出知识能力清单（供项目激活时调用，缺失不再静默）。 */
export function logKnowledgeCapabilities(
  paths: KnowledgeDbPaths,
  options: KnowledgeCapabilitiesOptions,
  log: KnowledgeCapabilityLogger,
): void {
  const capabilities = resolveKnowledgeCapabilities(paths, options);
  if (capabilities.every(cap => cap.status === "ready")) {
    log.info("[sati] knowledge: all ready");
  } else {
    log.warn(`[sati] knowledge: ${formatKnowledgeCapabilities(capabilities)}`);
  }
}
