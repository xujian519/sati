/**
 * 知识系统能力自检（诊断）。
 *
 * 与 assemble.ts 的组装逻辑严格对齐：判定结果反映运行时实际启用的能力，
 * 供启动时输出可读能力清单，避免数据/配置缺失时静默降级。
 */

import type { KnowledgeDbPaths } from "./config.js";
import type { KnowledgeRuntimeStatsSnapshot } from "./shared/knowledge-stats.js";
import { openKnowledgeDb } from "./shared/db-version.js";
import { KNOWLEDGE_DB } from "./shared/schema-versions.js";

export type KnowledgeCapabilityStatus = "ready" | "missing" | "disabled";

/** knowledge.db 关键表行数探测（进程内缓存：同进程知识库静态）。 */
type KnowledgeDbProbe = { kgNodes: number; lawArticles: number; embeddings: number; documents: number };

const probeCache = new Map<string, KnowledgeDbProbe>();

function probeKnowledgeDb(dbPath: string): KnowledgeDbProbe | null {
  const cached = probeCache.get(dbPath);
  if (cached) return cached;
  try {
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    const db = opened.db;
    try {
      const kgNodes = (db.prepare("SELECT COUNT(*) c FROM kg_nodes").get() as { c: number }).c;
      const lawArticles = (
        db.prepare("SELECT COUNT(*) c FROM documents WHERE doc_type = 'law_article'").get() as { c: number }
      ).c;
      const embeddings = (db.prepare("SELECT COUNT(*) c FROM embeddings").get() as { c: number }).c;
      // documents 全表计数：与 CaseLawSearchEngine.count()（装配判据）同一语句语义。
      const documents = (db.prepare("SELECT COUNT(*) c FROM documents").get() as { c: number }).c;
      const probe = { kgNodes, lawArticles, embeddings, documents };
      probeCache.set(dbPath, probe);
      return probe;
    } finally {
      db.close();
    }
  } catch {
    // 库打开失败或探测查询异常 → 判为不可探测（调用方按能力缺失处理）。
    return null;
  }
}

/** knowledge.db 路径存在时探测，否则 null。 */
function probeKnowledgeDbSafe(paths: KnowledgeDbPaths): KnowledgeDbProbe | null {
  return paths.knowledgeDb ? probeKnowledgeDb(paths.knowledgeDb) : null;
}

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
  // knowledge.db 关键表行数探测（一次提取；无 knowledge.db 时为 null）。
  const probe = probeKnowledgeDbSafe(paths);
  const capabilities: KnowledgeCapability[] = [
    {
      id: "patent-kg",
      label: "专利知识图谱",
      // knowledge.db 统一主库优先（kg_nodes），否则旧 patent_kg.db。
      status: probe?.kgNodes ? "ready" : paths.patentKgDb ? "ready" : "missing",
      detail: probe?.kgNodes
        ? `kg_nodes ${probe.kgNodes.toLocaleString()} 节点（knowledge.db）`
        : paths.patentKgDb
          ? undefined
          : "SATI_PATENT_KG_DB",
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
      status: probe?.lawArticles ? "ready" : paths.lawDb ? "ready" : "missing",
      detail: probe?.lawArticles
        ? `法规 ${probe.lawArticles} 部（knowledge.db）`
        : paths.lawDb
          ? undefined
          : "SATI_LAW_DB",
    },
    {
      id: "case-law",
      label: "专利判例全文",
      // 与 assemble 对齐（A1/A5 修复）：knowledge.db 主路径（documents 行数与
      // CaseLawSearchEngine.count() 同一语义）优先——
      //   probe.documents>0       → ready（knowledge.db 为准，与装配一致）
      //   probe 成功但 documents=0 → missing（空库不误报）
      //   probe 失败且主库存在     → missing（库损坏/表缺失，装配大概率失败）
      //   无主库                   → 回退 SATI_CASE_DB 独立库判定（legacy）
      status: probe?.documents ? "ready" : probe === null ? (paths.caseDb ? "ready" : "missing") : "missing",
      detail: probe?.documents
        ? `判例库 ${probe.documents.toLocaleString()} 篇（knowledge.db）`
        : probe === null
          ? paths.knowledgeDb
            ? "knowledge.db 不可用（打开失败或缺少 documents 表）"
            : "SATI_CASE_DB"
          : "knowledge.db 无判例文档（documents 为空）",
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
      // knowledge.db embeddings（XiaoNuo 产物，144K 向量）为主路径；vectors.db 为 legacy。
      status: probe?.embeddings ? "ready" : paths.vectorsDb ? "ready" : "disabled",
      detail: probe?.embeddings
        ? `knowledge.db embeddings ${probe.embeddings.toLocaleString()} 条（复用 XiaoNuo 产物）`
        : paths.vectorsDb
          ? undefined
          : "knowledge.db 无 embeddings（语义召回未启用）",
    },
    {
      id: "rerank",
      label: "重排 rerank",
      status: options.rerankConfigured ? "ready" : "disabled",
      detail: options.rerankConfigured ? undefined : "memory.embedding.rerank",
    },
  ];
  // 运行时降级联动（H3）：legal/case 引擎 FTS5 粘性降级（查询期异常）时，
  // 静态能力项如实降级——桌面端无 FTS5 的 Node 下不再误报 ready。
  const runtime = options.runtime;
  if (runtime) {
    for (const cap of capabilities) {
      if (cap.id === "legal-fts" && runtime.legalFtsDegraded) {
        cap.status = "missing";
        cap.detail = "FTS5 不可用，已降级 LIKE（运行中降级）";
      } else if (cap.id === "case-law" && runtime.caseLawFtsDegraded) {
        cap.status = "missing";
        cap.detail = "FTS5 不可用，已降级 LIKE（运行中降级）";
      }
    }
  }
  // 运行时能力项：仅在有运行时快照时追加（探测结果来自 provider 打点）。
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
