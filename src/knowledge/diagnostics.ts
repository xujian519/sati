/**
 * 知识系统能力自检（诊断）。
 *
 * 供启动时输出可读能力清单，避免数据/配置缺失时静默降级。
 *
 * ## 语义契约（2026-09-15 显式化，issue #366）
 *
 * 一次 `ready` 此前同时被读成两件事——「数据可用」与「已装配进模型上下文」——
 * 二者对 `case-law` 并不等价（自动注入只从 `options.knowledgeDb` 接线，而
 * `SATI_CASE_DB` 独立库走的是 `patent_case_search` 工具路径）。故拆成两项：
 *
 * - `status`：该能力在当前配置下**是否可用**（路径存在性 + knowledge.db 行数探测，
 *   粗粒度：不验证文件可打开、不验证外部服务可达）。
 * - `autoInject`：可用时其结果是否**经 memory provider 自动注入模型上下文**；
 *   `false` 表示仅经显式工具可达（工具名写在 `detail` 里）。
 *
 * 「ready 且 `autoInject === false`」是合法组合，且必须显式出现在输出里
 * （`detail` 文案 + 一行清单提示），否则会把「工具可用」读成「已装配」。
 *
 * 判定与 `assemble.ts` 的**接线条件**逐条同源（何处接线、用什么判据），
 * 但不再声称「diagnostics 的 ready ⇔ 已装配」。
 *
 * ## 运行期事实由施效侧上报（2026-09-16，issue #376 A6/A8）
 *
 * 有两类判据无法从「路径是否存在 / 配置是否打开」推出，只能由**真正施效的那一侧**
 * 在探测点上报（`KnowledgeRuntimeStats.kgFts` / `vectorDbProbe`），诊断只做判定：
 *
 * - `vectors.db` 的**实际已索引语料**：库里只有 `"kg"` 语料时，索引没有任何消费者
 *   （KG 语义召回已迁 knowledge.db embeddings）；打开失败/版本过旧也不是
 *   「路径存在」能表达的。被消费的语料由消费者自己声明（`LEGAL_VECTOR_CORPUS`），
 *   诊断与消费者读同一份声明。
 * - KG FTS 的 **schema 与表存在性**：同一个 `ftsMode` 在两种 schema 下治理方式不同
 *   （unified 用 `trim-knowledge-db.ts --rebuild-kg-fts`，legacy 用
 *   `migrate-kg-fts-trigram.mjs`），且 `ftsMode=none` 的两种成因（库中无 FTS 表 /
 *   运行时无 FTS5）指向完全不同的动作。
 *
 * 判据不得由入参反推（两侧同源必恒真，见 #360 教训）：`kgFts` 取自 kg-store 的
 * 表结构探测结果，`vectorDbProbe` 取自刚打开的 vectors.db 的 `vector_meta`。
 */

import type { KnowledgeDbPaths } from "./config.js";
import type { KgFtsMode, KgFtsProbe, KnowledgeRuntimeStatsSnapshot, VectorDbProbe } from "./shared/knowledge-stats.js";
import { LEGAL_VECTOR_CORPUS } from "./legal/legal-memory-provider.js";
import { openKnowledgeDb } from "./shared/db-version.js";
import { KNOWLEDGE_DB } from "./shared/schema-versions.js";

/** 能力可用性（粗粒度：路径存在性 + knowledge.db 行数探测，不验证可打开性）。 */
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
  /**
   * `ready` 时该能力的结果是否**经 memory provider 自动注入模型上下文**：
   * - `true`：已接入 provider，检索结果自动进入上下文（默认通道）；
   * - `false`：仅经显式工具/检索入口可用（工具名见 `detail`），**不自动注入**；
   * - 缺省（`undefined`）：非数据能力项（语义开关 / 运行时实现细节），通道语义不适用。
   */
  autoInject?: boolean;
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

/** 解析知识系统能力清单（除 knowledge.db 行数探测外，仅按路径存在性与配置判定）。 */
export function resolveKnowledgeCapabilities(
  paths: KnowledgeDbPaths,
  options: KnowledgeCapabilitiesOptions,
): KnowledgeCapability[] {
  // knowledge.db 关键表行数探测（一次提取；无 knowledge.db 时为 null）。
  const probe = probeKnowledgeDbSafe(paths);
  // 判例检索的两条通道（issue #366 显式化，判据与 assemble.ts / patentCaseSearch.ts 同源）：
  //   ① 主库 knowledge.db 的 documents>0 → assemble 接线 CaseLawMemoryProvider（自动注入）
  //   ② 独立 caseDb（未指回同一主库）   → 仅工具路径（patent_case_search 直用 caseDb）
  // ② 的判据是「路径已配置且不是主库本身」，不做存在性/行数探测——与其余路径型
  // 判据（patentKgDb/lawDb/vectorsDb）同一粗粒度，故 detail 里如实标注「未探测」。
  const caseDocs = probe?.documents ?? 0;
  const standaloneCaseDb = paths.caseDb && paths.caseDb !== paths.knowledgeDb ? paths.caseDb : undefined;
  const runtime = options.runtime;
  // 法规消费者是否在位（判据同 legal-fts 行）：semantic-vectors 的 vectors.db 分支只喂
  // LegalMemoryProvider，故该消费者不在位时索引无人读（#376 A6 的接线侧条件）。
  const legalLegAvailable = Boolean(probe?.lawArticles || paths.lawDb);
  const vectorsLegacy = resolveVectorsDbLegacy(paths, runtime?.vectorDbProbe, legalLegAvailable);
  const capabilities: KnowledgeCapability[] = [
    {
      id: "patent-kg",
      label: "专利知识图谱",
      // knowledge.db 统一主库优先（kg_nodes），否则旧 patent_kg.db。
      status: probe?.kgNodes ? "ready" : paths.patentKgDb ? "ready" : "missing",
      autoInject: true,
      detail: probe?.kgNodes
        ? `kg_nodes ${probe.kgNodes.toLocaleString()} 节点（knowledge.db）`
        : paths.patentKgDb
          ? undefined
          : "SATI_PATENT_KG_DB",
    },
    {
      // IPC 审查标准随仓库内置（ipc-standards.yaml），恒可用，由专利 provider 注入上下文。
      id: "patent-ipc",
      label: "IPC 审查标准",
      status: "ready",
      autoInject: true,
    },
    {
      id: "patent-wiki",
      label: "专利 wiki 卡片",
      status: paths.wikiDir ? "ready" : "missing",
      autoInject: true,
      detail: paths.wikiDir ? undefined : "SATI_WIKI_DIR",
    },
    {
      id: "legal-fts",
      label: "法律法规全文检索",
      status: probe?.lawArticles ? "ready" : paths.lawDb ? "ready" : "missing",
      autoInject: true,
      detail: probe?.lawArticles
        ? `法规 ${probe.lawArticles} 部（knowledge.db）`
        : paths.lawDb
          ? undefined
          : "SATI_LAW_DB",
    },
    {
      id: "case-law",
      label: "专利判例全文",
      // 与 assemble 对齐（A1/A5 修复）：主库路径以 documents 行数为准（与
      // CaseLawSearchEngine.count() 同一语义），而不是 knowledge.db 是否存在；
      //   caseDocs>0                     → ready（knowledge.db 为准，与装配一致）
      //   probe 成功但 documents=0 且无独立库 → missing（空库不误报）
      //   无主库（或主库不可探测）且有独立库 → ready（仅工具路径，autoInject=false）
      // 主库存在却不可探测、又无独立库时判 missing——装配与工具会同时失败（此前
      // caseDb 回落到主库本身而误报 ready，与本节注释矛盾）。
      status: caseDocs > 0 || standaloneCaseDb ? "ready" : "missing",
      autoInject: caseDocs > 0,
      detail:
        caseDocs > 0
          ? `判例库 ${caseDocs.toLocaleString()} 篇（knowledge.db，自动注入）`
          : standaloneCaseDb
            ? `SATI_CASE_DB 独立库（未探测）：经 patent_case_search 工具可用，不自动注入${
                probe ? "（knowledge.db 主库无判例文档）" : ""
              }`
            : probe
              ? "knowledge.db 无判例文档（documents 为空）"
              : paths.knowledgeDb
                ? "knowledge.db 不可用（打开失败或缺 documents 表），且无独立 SATI_CASE_DB"
                : "SATI_CASE_DB",
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
      // knowledge.db embeddings（XiaoNuo 产物，144K 向量）为主路径；vectors.db 为 legacy 备选。
      // 备选分支按「实际语料 ∩ 被消费语料 + 消费者在位」判定（#376 A6）：仅看路径存在性
      // 会把「有索引无消费者」报成 ready。主库 embeddings 分支不在此列——它的消费者
      // 还有判例语义与项目笔记两条，与法规消费者是否在位无关。
      status: probe?.embeddings ? "ready" : vectorsLegacy.status,
      detail: probe?.embeddings
        ? `knowledge.db embeddings ${probe.embeddings.toLocaleString()} 条（复用 XiaoNuo 产物）`
        : vectorsLegacy.detail,
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
  // 注：自动注入本身仍在（引擎转 LIKE），故不动 autoInject；降级事实由
  // status=missing + detail 表达。
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
      // 提示按 schema 与表存在性分流（#376 A8）：同一条提示对 unified/legacy 不通用。
      detail: kgFtsDetail(mode, runtime.kgFts),
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

/**
 * vectors.db **被消费的语料**声明（各消费者自己的声明取并集）。
 *
 * 目前唯一消费者是法条语义路（`LEGAL_VECTOR_CORPUS`）：KG 语义召回已迁
 * knowledge.db embeddings，故 legacy 库里的 `"kg"` 语料没有消费者。诊断与
 * 消费者读同一常量，改语料名不会让两侧悄悄错位（issue #376 A6）。
 */
const VECTOR_DB_CONSUMED_CORPORA: readonly string[] = [LEGAL_VECTOR_CORPUS];

/**
 * vectors.db（legacy 语义索引）能力判定（issue #376 A6）。
 *
 * 判据 = 「库中实际已索引语料 ∩ 被消费语料 ≠ ∅」且「消费者在位」——只报
 * 「索引文件在」会掩盖两种「有索引无消费者」：只含 `"kg"` 语料的库，以及
 * 有 `"law"` 语料但没有法规引擎（`LegalMemoryProvider` 未组装）的库。
 * 未提供运行时快照时退回路径型粗粒度判定（与其余路径型判据同一粒度，detail
 * 如实标注「本次未探测语料」）。
 */
function resolveVectorsDbLegacy(
  paths: KnowledgeDbPaths,
  probe: VectorDbProbe | undefined,
  legalLegAvailable: boolean,
): { status: KnowledgeCapabilityStatus; detail: string } {
  const consumedHint = VECTOR_DB_CONSUMED_CORPORA.join("/");
  if (!paths.vectorsDb) {
    return { status: "disabled", detail: "knowledge.db 无 embeddings（语义召回未启用）" };
  }
  if (!probe) {
    return { status: "ready", detail: `vectors.db（本次未探测语料；仅 ${consumedHint} 语料有消费者）` };
  }
  if (!probe.opened) {
    return { status: "missing", detail: `vectors.db 打不开（${probe.reason}），语义召回降级跳过` };
  }
  const consumed = probe.corpora.filter(corpus => VECTOR_DB_CONSUMED_CORPORA.includes(corpus));
  if (consumed.length === 0) {
    return {
      status: "missing",
      detail: `vectors.db 无被消费语料（已索引：${
        probe.corpora.length > 0 ? probe.corpora.join("/") : "空"
      }；仅 ${consumedHint} 被法条语义路消费）`,
    };
  }
  if (!legalLegAvailable) {
    return {
      status: "missing",
      detail: `vectors.db 有 ${consumed.join("/")} 语料但无法规消费者（知识库无 law_article 且未配 SATI_LAW_DB）`,
    };
  }
  return { status: "ready", detail: `vectors.db 语料 ${consumed.join("/")}（法条语义路消费）` };
}

/**
 * KG FTS 提示文案（按 schema 与表存在性分流，issue #376 A8）。
 *
 * 同一个 mode 的治理方式与 schema 绑定：`unicode61` 在 legacy 上可用 migrate
 * 脚本升级，unified 上该脚本不适用（它只服务 patent_kg.db）。`like`（=表缺失或
 * prepare 失败）的成因也决定动作：表缺失靠重建，运行时无 FTS5 只能换环境。
 * 未上报探测明细（旧快照/未接线）时退回改造前的 legacy 口径文案。
 */
function kgFtsDetail(mode: KgFtsMode, probe: KgFtsProbe | undefined): string {
  if (mode === "trigram") return "trigram";
  if (mode === "unicode61") {
    if (probe?.schema === "unified") {
      // knowledge.db 的 kg_nodes_fts 由 XiaoNuo 导入管道建；migrate 脚本只写
      // patent_kg.db 的 nodes_fts*，故统一库提示重建入口而非 migrate。
      return "unicode61（knowledge.db 的 kg_nodes_fts 非 trigram；重建：scripts/trim-knowledge-db.ts --rebuild-kg-fts）";
    }
    return "unicode61（建议执行 scripts/migrate-kg-fts-trigram.mjs 升级 trigram）";
  }
  if (probe && !probe.tablePresent) {
    return probe.schema === "unified"
      ? "库中无 KG FTS 表（检索已降级 LIKE）；该表由知识库导入管道生成，trim 的 --rebuild-kg-fts 仅重建已存在的表"
      : "库中无 KG FTS 表（检索已降级 LIKE）；重建：node scripts/migrate-kg-fts-trigram.mjs <patent_kg.db>";
  }
  return "FTS5 不可用已回退 LIKE（如桌面端捆绑 Node 未编译 FTS5）";
}

/**
 * 格式化为单行紧凑清单（id=status(提示)，供 console 输出）。
 *
 * `ready` 行默认不带提示（清单保持可扫读）；但 `ready` 且 `autoInject === false`
 * 时**必须**带提示——「可用但未自动注入」是指令级事实，省掉它这一行就会被读成
 * 「已装配」（issue #366）。
 */
export function formatKnowledgeCapabilities(capabilities: KnowledgeCapability[]): string {
  return capabilities
    .map(cap => {
      const hint = cap.status === "ready" && cap.autoInject !== false ? "" : `(${cap.detail ?? "未配置"})`;
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
  // 全部 ready 时一行 info 收口，但「可用却未自动注入」的项要在此点名——
  // 否则「all ready」会把工具路径读成已装配（issue #366）。
  const notInjected = capabilities.filter(cap => cap.status === "ready" && cap.autoInject === false);
  if (capabilities.every(cap => cap.status === "ready")) {
    log.info(
      notInjected.length > 0
        ? `[sati] knowledge: all ready（${notInjected.map(cap => cap.id).join("/")} 仅经工具可用，未自动注入）`
        : "[sati] knowledge: all ready",
    );
    return;
  }
  log.warn(`[sati] knowledge: ${formatKnowledgeCapabilities(capabilities)}`);
}
