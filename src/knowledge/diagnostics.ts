/**
 * 知识系统能力自检（诊断）。
 *
 * 与 assemble.ts 的组装逻辑严格对齐：判定结果反映运行时实际启用的能力，
 * 供启动时输出可读能力清单，避免数据/配置缺失时静默降级。
 */

import type { KnowledgeDbPaths } from "./config.js";

export type KnowledgeCapabilityStatus = "ready" | "missing" | "disabled";

export type KnowledgeCapability = {
  /** 能力标识（稳定，供程序消费）。 */
  id: "patent-kg" | "patent-ipc" | "patent-wiki" | "legal-fts" | "semantic-embedding" | "semantic-vectors" | "rerank";
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
};

/** 解析知识系统能力清单（不打开数据库，仅按路径探测与配置判定）。 */
export function resolveKnowledgeCapabilities(
  paths: KnowledgeDbPaths,
  options: KnowledgeCapabilitiesOptions,
): KnowledgeCapability[] {
  return [
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
      id: "semantic-embedding",
      label: "语义 embedding",
      status: options.embeddingConfigured ? "ready" : "disabled",
      detail: options.embeddingConfigured ? undefined : "memory.embedding.enabled",
    },
    {
      id: "semantic-vectors",
      label: "离线语义索引",
      status: paths.vectorsDb ? "ready" : "disabled",
      detail: paths.vectorsDb ? undefined : "build-knowledge-vectors.ts",
    },
    {
      id: "rerank",
      label: "重排 rerank",
      status: options.rerankConfigured ? "ready" : "disabled",
      detail: options.rerankConfigured ? undefined : "memory.embedding.rerank",
    },
  ];
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
