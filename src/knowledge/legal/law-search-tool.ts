import { join } from "node:path";
import type { SatiToolDefinition } from "../../tool/protocol/types.js";
import { resolveKnowledgeDbPaths } from "../config.js";
import { LegalSearchEngine, type LegalSearchOptions } from "./legal-search.js";
import { KnowledgeLawSearch } from "./knowledge-law-search.js";
import {
  LEGAL_SNAPSHOT_MANIFEST_FILE,
  LegalSnapshotEngine,
  SNAPSHOT_UNSUPPORTED_FILTERS,
  resolveLegalSnapshotDir,
} from "./offline-snapshot/index.js";
import { computeEffectiveStatus, loadLawVersionMeta, type LawVersionMeta } from "./version-meta.js";
import type { LawRecord, LawStatus, LegalSearchSource } from "./types.js";

/**
 * law_search — 中国法律法规全文检索。
 *
 * 法规后端优先级：knowledge.db（doc_type='law_article'，XiaoNuo 产物，
 * docs_fts trigram + BM25）→ laws-full.db（宝宸知识库 Laws-1.0.0）→
 * 离线法条快照（assets/legal-snapshot，随包分发，仅收录已转录正文的法条）。
 * FTS5 优先，短查询/缺失 FTS 时降级 LIKE；离线快照为线性匹配。
 *
 * 在线与离线不是「双事实源」：在线可用时优先，快照只在两者都不可用时启用；
 * 输出以 `source`（online/offline）+ `snapshotAt`（快照时点）显式标注，
 * 让调用方与模型知道当前结果是实时索引还是冻结快照。
 */

export type LawSearchToolInput = {
  /** 搜索关键词或法条内容（如 "专利法"、"第二十二条"、"创造性"） */
  query: string;
  /** 法律层级过滤（法律/行政法规/司法解释/地方性法规/宪法/案例/部门规章） */
  level?: string;
  /** 分类名称过滤（如 "民法商法"、"行政法"） */
  category?: string;
  /** 返回条数上限（默认 5） */
  limit?: number;
  /**
   * 时点过滤（YYYY-MM-DD）：只返回该日已存在的版本。
   * 输出以 `timeFilter` 标明精确（施行日/失效字段）或近似（公布日期下界）。
   */
  asOf?: string;
};

/** 效力状态来源：db=数据源硬字段（expired/publish），version-meta=离线版本沿革，unknown=未提供。 */
export type LawStatusSource = "db" | "version-meta" | "unknown";

export type LawSearchToolResult = LawRecord & {
  snippet?: string;
  statusSource: LawStatusSource;
  /** 结果来源：online=实时数据库索引；offline=随包冻结快照。 */
  source: "online" | "offline";
  /** 离线快照构建时点（YYYY-MM-DD；仅 source=offline 时存在）。 */
  snapshotAt?: string;
};

export type LawSearchToolOutput = {
  total: number;
  results: LawSearchToolResult[];
  /** 本次检索使用的后端来源（在线优先；离线为兜底）。 */
  source: "online" | "offline";
  dbPath?: string;
  /** 离线快照目录/清单路径（仅 source=offline 时存在）。 */
  snapshotPath?: string;
  /** 离线快照构建时点（仅 source=offline 时存在）。 */
  snapshotAt?: string;
  /** 离线快照收录的法律部数（仅 source=offline 时存在；回答「快照覆盖了哪些」的规模面）。 */
  snapshotLawCount?: number;
  /** 离线快照收录的条文总数（仅 source=offline 时存在）。 */
  snapshotArticleCount?: number;
  /** 在线库不可用而回退离线快照的原因（仅 source=offline 时存在）。 */
  degradedReason?: string;
  /** 快照不支持、被忽略的过滤维度（如 level/category；不静默假装已过滤）。 */
  unsupportedFilters?: Array<"level" | "category">;
  /** 时点过滤回显（仅提供 asOf 时）。 */
  asOf?: string;
  /** 时点口径：exact=按施行日/失效字段；approximate=按公布日期下界近似；unsupported=数据源无日期字段（未按时点过滤）。 */
  timeFilter?: "exact" | "approximate" | "unsupported";
  /** 因日期缺失无法证明早于 asOf、被排除的候选数（仅提供 asOf 时；unsupported 口径下为全部命中数）。 */
  unknownDateCount?: number;
};

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 严格校验 YYYY-MM-DD（含日历合法性，如 2023-02-30 非法）。 */
function isValidIsoDate(value: string): boolean {
  const match = ISO_DATE_RE.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** 可用后端：在线库或离线快照（附来源与降级原因）。 */
export type LawSearchBackend = {
  engine: LegalSearchSource;
  /** 来源标记；注入的测试后端可省略（缺省按 online 处理）。 */
  source?: "online" | "offline";
  dbPath?: string;
  snapshotPath?: string;
  snapshotAt?: string;
  /** 快照收录规模（仅离线后端填；输出层如实回报）。 */
  snapshotLawCount?: number;
  snapshotArticleCount?: number;
  degradedReason?: string;
  unsupportedFilters?: Array<"level" | "category">;
};

/** 后端解析结果：要么可用，要么给出**每一条**候选失败原因（不静默）。 */
export type LawSearchResolution = LawSearchBackend | { engine: null; reasons: string[] };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析法规后端（在线优先、离线兜底）。
 *
 * 顺序固定：knowledge.db → laws-full.db → 离线快照。每条候选失败都记入 reasons，
 * 全失败时由工具以 setup_required + 原因列表返回（「为什么没数据」可诊断）。
 *
 * @param options.env - 环境变量（测试注入）；默认 process.env。
 * @param options.snapshotDir - 指定离线快照目录（测试注入）；默认按候选目录定位。
 */
export function resolveLawSearchBackend(
  options: { env?: NodeJS.ProcessEnv; snapshotDir?: string } = {},
): LawSearchResolution {
  const env = options.env ?? process.env;
  const { lawDb, knowledgeDb } = resolveKnowledgeDbPaths(env);
  const reasons: string[] = [];

  if (knowledgeDb) {
    try {
      const engine = new KnowledgeLawSearch(knowledgeDb);
      if (engine.count() > 0) return { engine, source: "online", dbPath: knowledgeDb };
      reasons.push(`knowledge.db 可打开但没有 law_article 文档：${knowledgeDb}`);
      engine.close();
    } catch (error) {
      reasons.push(`knowledge.db 不可用：${messageOf(error)}`);
    }
  } else {
    reasons.push("knowledge.db 不存在");
  }

  if (lawDb) {
    try {
      return { engine: new LegalSearchEngine(lawDb), source: "online", dbPath: lawDb };
    } catch (error) {
      reasons.push(`laws-full.db 不可用：${messageOf(error)}`);
    }
  } else {
    reasons.push("laws-full.db 不存在");
  }

  const snapshotDir = options.snapshotDir ?? resolveLegalSnapshotDir(env);
  if (snapshotDir) {
    try {
      const engine = new LegalSnapshotEngine(snapshotDir);
      return {
        engine,
        source: "offline",
        snapshotPath: join(snapshotDir, LEGAL_SNAPSHOT_MANIFEST_FILE),
        snapshotAt: engine.manifest.snapshotAt,
        snapshotLawCount: engine.manifest.lawCount,
        snapshotArticleCount: engine.manifest.articleCount,
        degradedReason: reasons.join("；"),
        unsupportedFilters: [...SNAPSHOT_UNSUPPORTED_FILTERS],
      };
    } catch (error) {
      reasons.push(`离线法条快照不可用：${messageOf(error)}`);
    }
  } else {
    reasons.push("离线法条快照缺失（assets/legal-snapshot 或 SATI_LEGAL_SNAPSHOT_DIR）");
  }

  return { engine: null, reasons };
}

/** 模块级缓存：只缓存可用后端（全失败不缓存，放置数据文件后下次调用可重试）。 */
let cachedResolution: { key: string; resolution: LawSearchResolution } | null = null;

function defaultResolution(): LawSearchResolution {
  const paths = resolveKnowledgeDbPaths();
  const snapshotDir = resolveLegalSnapshotDir();
  const key = `${paths.knowledgeDb ?? "-"}|${paths.lawDb ?? "-"}|${snapshotDir ?? "-"}`;
  if (cachedResolution !== null && cachedResolution.key === key) return cachedResolution.resolution;
  if (cachedResolution !== null) {
    const previous = cachedResolution.resolution;
    if (previous.engine !== null) previous.engine.close();
    cachedResolution = null;
  }
  const resolution = resolveLawSearchBackend({ env: process.env, snapshotDir });
  if (resolution.engine === null) return resolution;
  cachedResolution = { key, resolution };
  return resolution;
}

/** 截断过长的法条正文（避免超大输出撑爆上下文）。 */
function truncateContent(content: string, maxChars = 4000): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n…（截断，共 ${content.length} 字）`;
}

/** 离线版本沿革 meta 缓存（构造期加载一次，不在请求路径读盘；缺失/损坏降级空 map）。 */
let versionMetaCache: Map<string, LawVersionMeta> | null = null;

function getVersionMeta(): Map<string, LawVersionMeta> {
  if (versionMetaCache === null) versionMetaCache = loadLawVersionMeta();
  return versionMetaCache;
}

/**
 * 版本状态标注：按位置（computeEffectiveStatus）+ 失效标志 + 离线 meta 覆盖。
 *
 * 优先级：meta 的「已废止/待核验」（离线治理结论） > expired=1（laws-full 硬数据）
 * > 版本位置（仅同名多版本时有值） > meta 的「现行有效/已被修订」 > expired=0（不标）
 * > 待核验（无任何来源）。
 *
 * 单版本且 meta 明确给出状态时采用 meta（避免明明有离线结论却回落「待核验」），
 * 但 meta 不得把 expired=1 改写成「现行有效」——冲突时保留更强的失效证据。
 * expired 缺失（knowledge.db 无该列）且无其它来源时标「待核验」并回报
 * statusSource=unknown，不得回落成「现行有效」（#731）。
 */
function resolveVersionStatus(
  position: LawStatus | undefined,
  expired: number | undefined,
  metaStatus: LawStatus | undefined,
): { status?: LawStatus; statusSource: LawStatusSource } {
  if (metaStatus === "已废止" || metaStatus === "待核验") {
    return { status: metaStatus, statusSource: "version-meta" };
  }
  if (expired === 1) return { status: "已废止", statusSource: "db" };
  if (position !== undefined) return { status: position, statusSource: "db" };
  if (metaStatus !== undefined) return { status: metaStatus, statusSource: "version-meta" };
  if (expired === 0) return { status: undefined, statusSource: "db" };
  return { status: "待核验", statusSource: "unknown" };
}

export function createLawSearchTool(
  getEngineFn: () => LawSearchResolution = defaultResolution,
  getVersionMetaFn: () => Map<string, LawVersionMeta> = getVersionMeta,
): SatiToolDefinition<LawSearchToolInput, LawSearchToolOutput> {
  return {
    name: "law_search",
    outputSchema: {
      type: "object",
      // source 只作诊断提示：不要求调用方/严格消费者解析（旧消费者按 required 校验不受影响）。
      required: ["total", "results"],
      properties: {
        total: { type: "number" },
        source: { type: "string", enum: ["online", "offline"] },
        dbPath: { type: "string" },
        snapshotPath: { type: "string" },
        snapshotAt: { type: "string" },
        snapshotLawCount: { type: "number" },
        snapshotArticleCount: { type: "number" },
        degradedReason: { type: "string" },
        unsupportedFilters: { type: "array", items: { type: "string", enum: ["level", "category"] } },
        asOf: { type: "string" },
        timeFilter: { type: "string", enum: ["exact", "approximate", "unsupported"] },
        unknownDateCount: { type: "number" },
        results: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: true,
            properties: {
              name: { type: "string" },
              level: { type: "string" },
              category: { type: "string" },
              article: { type: "string" },
              content: { type: "string" },
              snippet: { type: "string" },
              publish: { type: "string" },
              status: { type: "string" },
              statusSource: { type: "string", enum: ["db", "version-meta", "unknown"] },
              source: { type: "string", enum: ["online", "offline"] },
              snapshotAt: { type: "string" },
            },
          },
        },
      },
    },
    title: "Law Search",
    description:
      "搜索中国法律法规全文（宝宸知识库 9000+ 部法律）。支持全文关键词检索、按法律层级（法律/行政法规/司法解释/地方性法规/宪法/案例/部门规章）和分类过滤。用于查询法条原文、法律名称、立法依据。优先读实时在线索引；离线库缺失/损坏时退回随包冻结快照，输出以 source（online/offline）与 snapshotAt（快照时点）显式标注，离线时另附 snapshotLawCount/snapshotArticleCount 如实回报快照收录规模，并在 unsupportedFilters 回报快照不支持的过滤维度。提供 asOf（YYYY-MM-DD）时按行为时点过滤，并输出 timeFilter（exact=按施行日/失效字段；approximate=按公布日期下界近似；unsupported=快照无日期字段未过滤）与 unknownDateCount（日期未知未纳入数）。",
    kind: "custom",
    domain: "legal",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: {
          type: "string",
          description: "搜索关键词或法条内容（如 专利法、第二十二条、创造性）",
        },
        level: {
          type: "string",
          enum: ["法律", "行政法规", "司法解释", "地方性法规", "宪法", "案例", "部门规章"],
          description: "法律层级过滤",
        },
        category: {
          type: "string",
          description: "分类名称过滤（如 民法商法、行政法、刑法）",
        },
        limit: {
          type: "number",
          description: "返回条数上限（默认 5，最大 20）",
        },
        asOf: {
          type: "string",
          description:
            "时点过滤（YYYY-MM-DD，如 2020-10-17）：只返回该日已存在的版本；输出标注 timeFilter（exact/approximate）与 unknownDateCount。非法日期返回 invalid_as_of。",
        },
      },
      required: ["query"],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    checkAvailability: () => {
      const resolved = getEngineFn();
      if (resolved.engine === null) {
        return {
          ok: false,
          code: "setup_required",
          reason: `未找到可用的法律数据源（在线库与离线快照均不可用）：${resolved.reasons.join("；")}`,
        };
      }
      return { ok: true };
    },
    execute: async (input: LawSearchToolInput) => {
      const resolved = getEngineFn();
      if (resolved.engine === null) {
        return {
          content: [
            {
              type: "text",
              text: `错误：未找到可用的法律数据源（在线库与离线快照均不可用）。原因：${resolved.reasons.join("；")}`,
            },
          ],
          metadata: { error: "law_db_not_found", reasons: resolved.reasons },
        };
      }
      const backend = resolved;
      const { engine } = backend;

      // 时点参数 fail-loud：非法格式不静默忽略（否则模型会误以为已过滤）。
      const asOf = input.asOf;
      if (asOf !== undefined && !isValidIsoDate(asOf)) {
        return {
          content: [{ type: "text", text: `错误：asOf 必须是合法的 YYYY-MM-DD 日期（收到 "${asOf}"），未执行检索。` }],
          metadata: { error: "invalid_as_of" },
        };
      }

      const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
      const options: LegalSearchOptions = {
        limit,
        level: input.level,
        category: input.category,
        ...(asOf !== undefined ? { asOf } : {}),
      };

      // 来源标记：逐条结果都带（模型只读到零散结果时也能分辨在线/快照）。
      const source = backend.source ?? "online";
      const resultTag = {
        source,
        ...(source === "offline" && backend.snapshotAt !== undefined ? { snapshotAt: backend.snapshotAt } : {}),
      };
      // 快照不支持的过滤维度只在调用方确实用了该过滤时回报（避免噪音）。
      const unsupportedFilters = (backend.unsupportedFilters ?? []).filter(
        filter =>
          (filter === "level" && input.level !== undefined) || (filter === "category" && input.category !== undefined),
      );

      // 优先精确名称匹配（结果中保持该法律在前）。
      // 搜索结果按不同法律名配额取数（limit 即配额；多取的行经 seen 去重丢弃）。
      const byName =
        input.query.length >= 2 ? engine.findByName(input.query, 3, asOf !== undefined ? { asOf } : undefined) : [];
      // 时点检索走 searchAt（带口径元数据）；缺省路径行为不变。
      const timed = asOf !== undefined ? engine.searchAt(input.query, { ...options, asOf }) : undefined;
      const results = timed?.results ?? engine.search(input.query, options);

      // 精确名命中按 name 分组：同名多版本（如 laws-full 多版本库）标注
      // status/supersededBy（A2 版本沿革——输出"当前版本/历史版本"）；单版本不标避免噪音。
      const byNameGroups = new Map<string, Array<LawRecord & { snippet?: string }>>();
      for (const r of byName) {
        const key = r.name;
        if (!byNameGroups.has(key)) byNameGroups.set(key, []);
        byNameGroups.get(key)!.push({ ...r, content: r.content ? truncateContent(r.content) : undefined });
      }

      const versionMeta = getVersionMetaFn();
      const merged: LawSearchToolResult[] = [];
      const seen = new Set<string>();
      // 「不同法律名」配额：同名多版本不挤占不同法律（同名全部版本都展示，
      // 保留版本沿革价值，但每个 name 只占 1 席配额——不同法律数 ≤ limit）。
      let nameCount = 0;
      for (const [name, versions] of byNameGroups) {
        if (seen.has(name) || nameCount >= limit) continue;
        seen.add(name);
        nameCount += 1;
        versions.sort((a, b) => (b.publish ?? "").localeCompare(a.publish ?? ""));
        const metaStatus = versionMeta.get(name)?.status;
        const dates = versions.map(v => v.publish ?? "");
        const latestLabel = versions[0]!.publish ? `${name}（${versions[0]!.publish} 版）` : name;
        versions.forEach(r => {
          // 位置状态经 computeEffectiveStatus 判定（生产接线，收口内联重复）；
          // 单版本时 position 为 undefined（不标，避免噪音）。
          const position = versions.length > 1 ? computeEffectiveStatus(dates, r.publish ?? "") : undefined;
          const { status, statusSource } = resolveVersionStatus(position, r.expired, metaStatus);
          merged.push({
            ...r,
            ...(status === undefined ? {} : { status }),
            // 单版本可能经 meta 得到「已被修订」，此时没有后继版本可指向，不写自指 supersededBy。
            ...(status === "已被修订" && versions.length > 1 ? { supersededBy: latestLabel } : {}),
            statusSource,
            ...resultTag,
          });
        });
      }

      // 全文检索命中：按 name 去重保留最新版（现状），跳过已由精确名引入的；
      // 命中过期/已废止法律时补失效标注（不硬过滤，标给模型判断）。
      for (const r of results) {
        if (nameCount >= limit) break;
        if (seen.has(r.name)) continue;
        seen.add(r.name);
        nameCount += 1;
        const metaStatus = versionMeta.get(r.name)?.status;
        const { status, statusSource } = resolveVersionStatus(undefined, r.expired, metaStatus);
        merged.push({
          ...r,
          ...(status === undefined ? {} : { status }),
          content: r.content ? truncateContent(r.content) : undefined,
          statusSource,
          ...resultTag,
        });
      }

      const output: LawSearchToolOutput = {
        total: merged.length,
        results: merged,
        source,
        ...(backend.dbPath === undefined ? {} : { dbPath: backend.dbPath }),
        ...(source === "offline"
          ? {
              ...(backend.snapshotPath === undefined ? {} : { snapshotPath: backend.snapshotPath }),
              ...(backend.snapshotAt === undefined ? {} : { snapshotAt: backend.snapshotAt }),
              ...(backend.snapshotLawCount === undefined ? {} : { snapshotLawCount: backend.snapshotLawCount }),
              ...(backend.snapshotArticleCount === undefined
                ? {}
                : { snapshotArticleCount: backend.snapshotArticleCount }),
              ...(backend.degradedReason === undefined ? {} : { degradedReason: backend.degradedReason }),
            }
          : {}),
        ...(unsupportedFilters.length > 0 ? { unsupportedFilters } : {}),
        ...(asOf !== undefined
          ? {
              asOf,
              timeFilter: timed?.meta.timeFilter ?? engine.timeFilter,
              unknownDateCount: timed?.meta.unknownDateCount ?? 0,
            }
          : {}),
      };
      return {
        content: [{ type: "json", value: output }],
        data: output,
        metadata: {
          domain: "legal",
          source,
          ...(backend.dbPath === undefined ? {} : { dbPath: backend.dbPath }),
          ...(source === "offline" && backend.snapshotPath !== undefined ? { snapshotPath: backend.snapshotPath } : {}),
          fts5: engine.ftsAvailable,
          ...(asOf !== undefined ? { asOf } : {}),
        },
      };
    },
  };
}
