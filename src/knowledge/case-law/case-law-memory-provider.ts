/**
 * CaseLawMemoryProvider — 判例全文 MemoryResolver（判例自动注入）。
 *
 * 把判例全文（knowledge.db documents/chunks/docs_fts，含无效复审决定与专利判决）
 * 接入 <memory-context> 自动注入链，OA/无效类 query 下自动注入相似在先决定的
 * 论证片段，与显式工具 patent_case_search 互补——不再依赖模型"记得"调用工具。
 *
 * 触发门控：query 命中 triggerKeywords（创造性/无效/答复/区别特征/技术启示等）
 * 才检索，普通对话不注入，避免上下文膨胀。
 *
 * 知识库只读：captureTurn 为空操作（与 PatentMemoryProvider 一致）。
 */

import type {
  MemoryCaptureTurnInput,
  MemoryResolver,
  MemoryRetrieveInput,
  MemoryRetrieveResult,
} from "../../context/memory/MemoryResolver.js";
import type { KnowledgeRuntimeStats } from "../shared/knowledge-stats.js";
import { CaseLawSearchEngine, type CaseLawSemanticSource } from "./case-law-search.js";
import { fuseCaseLawHits } from "./rrf.js";
import type { CaseLawHit } from "./types.js";

/** OA/无效/审查类任务触发词（命中任一即检索判例；缺省列表覆盖专利实务高频语义）。 */
const DEFAULT_TRIGGER_KEYWORDS: readonly string[] = [
  "创造性",
  "新颖性",
  "无效",
  "答复",
  "审查意见",
  "区别特征",
  "技术启示",
  "证据认定",
  "预料不到",
  "充分公开",
  "修改超范围",
  "单独对比",
  "三步法",
  "A22",
  "A26",
  "A33",
];

export type CaseLawMemoryProviderOptions = {
  /** 判例检索引擎；缺省或打开失败时 provider 禁用（诊断 memory_disabled）。 */
  engine?: CaseLawSearchEngine;
  /** 判例语义召回源（可选；未注入时语义路关闭，纯 FTS/LIKE）。 */
  semantic?: CaseLawSemanticSource;
  /** 是否启用判例注入（默认 true）。 */
  enableCaseLaw?: boolean;
  /** 注入判例条数上限（默认 2，防上下文膨胀）。 */
  caseLimit?: number;
  /** 命中片段截断字符数（默认 400，比工具的 800 更保守）。 */
  snippetMaxChars?: number;
  /** 触发关键词表（缺省 DEFAULT_TRIGGER_KEYWORDS）。 */
  triggerKeywords?: readonly string[];
  /** 运行时状态聚合（可选）。 */
  stats?: KnowledgeRuntimeStats;
  logger?: { warn?: (...args: unknown[]) => void };
};

export class CaseLawMemoryProvider implements MemoryResolver {
  private readonly engine?: CaseLawSearchEngine;
  private readonly enableCaseLaw: boolean;
  private readonly caseLimit: number;
  private readonly snippetMaxChars: number;
  private readonly triggerKeywords: readonly string[];
  private readonly stats?: KnowledgeRuntimeStats;
  private readonly logger?: { warn?: (...args: unknown[]) => void };

  constructor(options: CaseLawMemoryProviderOptions = {}) {
    this.engine = options.engine;
    this.enableCaseLaw = options.enableCaseLaw ?? true;
    this.caseLimit = Math.max(options.caseLimit ?? 2, 1);
    this.snippetMaxChars = Math.max(options.snippetMaxChars ?? 400, 100);
    this.triggerKeywords = options.triggerKeywords ?? DEFAULT_TRIGGER_KEYWORDS;
    this.stats = options.stats;
    this.logger = options.logger;
    if (options.semantic) this.engine?.setSemantic(options.semantic);
    this.stats?.setCaseLawAvailable(Boolean(this.engine));
  }

  async retrieve(input: MemoryRetrieveInput): Promise<MemoryRetrieveResult> {
    if (!this.enableCaseLaw) {
      return { diagnostics: [{ code: "memory_disabled", message: "判例自动注入已禁用", severity: "info" }] };
    }
    if (!this.engine) {
      return {
        diagnostics: [
          {
            code: "memory_disabled",
            message: "判例库不可用（未找到 knowledge.db 判例数据，可用 SATI_CASE_DB 指定）",
            severity: "info",
          },
        ],
      };
    }
    const query = input.query.trim();
    if (!query || !this.isTriggered(query)) {
      return { diagnostics: [] };
    }

    try {
      const ftsHits = this.engine.search(query, { limit: this.caseLimit * 2, excludeSource: "wiki" });
      let semanticHits: CaseLawHit[] = [];
      if (this.engine.semanticAvailable) {
        try {
          semanticHits = await this.engine.searchSemantic(query, this.caseLimit * 2);
        } catch (error) {
          // 语义路失败降级为纯 FTS/LIKE，不阻断注入。
          this.logger?.warn?.(`[case-law-memory] 判例语义召回失败，降级 FTS: ${String(error)}`);
        }
      }
      const hits = fuseCaseLawHits(ftsHits, semanticHits, this.caseLimit);
      if (hits.length === 0) {
        return { diagnostics: [{ code: "memory_context_empty", message: "判例检索无命中", severity: "info" }] };
      }
      const blocks = hits.map(hit => this.formatHit(hit));
      this.stats?.recordCaseLawInject(hits.length);
      return {
        systemContext: `<case-law>\n${blocks.join("\n\n")}\n</case-law>`,
        diagnostics: [
          {
            code: "memory_case_law_injected",
            message: `判例注入 ${hits.length} 条（${hits.map(h => h.docType).join("/")}）`,
            severity: "info",
          },
        ],
      };
    } catch (error) {
      this.logger?.warn?.(`[case-law-memory] 判例检索异常: ${String(error)}`);
      return {
        diagnostics: [
          {
            code: "memory_provider_error",
            message: `判例检索失败: ${error instanceof Error ? error.message : String(error)}`,
            severity: "warning",
          },
        ],
      };
    }
  }

  /** 知识库只读：不捕获任何会话内容。 */
  async captureTurn(_input: MemoryCaptureTurnInput): Promise<void> {
    // 空操作
  }

  /** 触发门控：query 是否命中专利实务语义（含法条号 A22/A26/A33 与关键概念词）。 */
  private isTriggered(query: string): boolean {
    return this.triggerKeywords.some(keyword => query.includes(keyword));
  }

  private formatHit(hit: CaseLawHit): string {
    const idParts = [
      hit.decisionNumber ? `决定号 ${hit.decisionNumber}` : undefined,
      hit.caseNumber ? `案号 ${hit.caseNumber}` : undefined,
      hit.court ? `法院 ${hit.court}` : undefined,
      hit.docType === "judgment" ? "判决" : "无效复审决定",
    ].filter(Boolean);
    const snippet =
      hit.snippet.length > this.snippetMaxChars
        ? `${hit.snippet.slice(0, this.snippetMaxChars)}…（截断）`
        : hit.snippet;
    return `<case doc_type="${hit.docType}" via="${hit.via}">\n标题: ${hit.title}${idParts.length > 0 ? `（${idParts.join("，")}）` : ""}\n片段: ${snippet}\n</case>`;
  }
}
