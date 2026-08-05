import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseDocument } from "yaml";

/**
 * Wiki 卡片加载器（数据源：src/knowledge/patent/wiki/，对齐 Mady WikiLoader + CardIndex）。
 *
 * - 扫描 wiki 目录下全部 .md 卡片（约 1548 张，不含商标目录）
 * - 加载 patent-cards/card-index.json 增强元数据（concept/domain/quality）
 * - 惰性按需读取正文（内存只存元数据，正文读后缓存）
 */

export type WikiCardMeta = {
  /** 卡片唯一标识：相对路径（不含 .md 扩展名） */
  id: string;
  /** 卡片标题（card-index 优先，否则文件名） */
  title: string;
  /** 相对 wiki 根的路径 */
  relativePath: string;
  /** card-index 增强字段 */
  concept?: string;
  domain?: string;
  quality?: number;
  relatedConcepts?: string[];
};

export type WikiCardContent = {
  meta: WikiCardMeta;
  /** Markdown 正文全文 */
  content: string;
  /** 元数据段（card-index 合并后的字段） */
  metadata: Record<string, string>;
};

/** card-index.json 结构（对齐 Mady CardIndex）。 */
type CardIndexJson = {
  totalCards?: number;
  lastUpdated?: string;
  cards?: Array<{
    id?: string;
    title?: string;
    concept?: string;
    quality?: number;
    domain?: string;
    filePath?: string;
    relatedConcepts?: string[];
  }>;
};

const CARD_INDEX_NAME = "card-index.json";
const MAX_CACHE_ENTRIES = 64;

export class WikiCardLoader {
  private readonly wikiPath: string;
  private readonly cards: WikiCardMeta[] = [];
  private readonly byId = new Map<string, WikiCardMeta>();
  private readonly contentCache = new Map<string, string>();
  private loaded = false;

  constructor(wikiPath: string) {
    this.wikiPath = wikiPath;
  }

  /** 扫描 wiki 目录 + card-index.json（惰性，首次调用时构建）。 */
  private ensureLoaded(): void {
    if (this.loaded) return;

    // 1. 扫描全部 .md 文件（loaded 在成功后置位：扫描抛错（坏符号链接/
    // 不可读目录）时保持未加载，后续调用可重试，避免永久污染加载器）
    let files: string[];
    try {
      files = this.scanMarkdownFiles(this.wikiPath);
    } catch {
      this.loaded = false;
      return;
    }
    this.loaded = true;
    for (const file of files) {
      const rel = relative(this.wikiPath, file);
      const id = rel.replace(/\.md$/, "");
      const title = this.titleFromFileName(id);
      const meta: WikiCardMeta = { id, title, relativePath: rel };

      // patent-cards 卡片头部含 `- 概念: X` 元数据行，提取增强索引
      if (rel.startsWith("patent-cards/")) {
        try {
          const head = readFileSync(file, "utf8").split("\n").slice(0, 20).join("\n");
          const metadata = this.extractMetadata(head);
          if (metadata["概念"]) meta.concept = metadata["概念"];
          if (metadata["领域"]) meta.domain = metadata["领域"];
          const quality = Number.parseFloat(metadata["质量分"]);
          if (Number.isFinite(quality)) meta.quality = quality;
        } catch {
          // 读取失败仅保留文件名标题
        }
      }
      this.byId.set(id, meta);
    }

    // 2. card-index.json 增强元数据（filePath 指向旧路径，按 id 匹配实际文件）
    const indexPath = join(this.wikiPath, "patent-cards", CARD_INDEX_NAME);
    if (existsSync(indexPath)) {
      try {
        const doc = parseDocument(readFileSync(indexPath, "utf8"));
        const parsed = doc.toJS() as CardIndexJson;
        for (const entry of parsed.cards ?? []) {
          if (!entry.id) continue;
          // card-index id 与 patent-cards 目录文件名（去 .md）一致
          const candidatePaths = [`patent-cards/${entry.id}`, `patent-cards/${this.safeFileStem(entry.id)}`];
          const target = candidatePaths.find(p => this.byId.has(p));
          if (!target) continue;
          const existing = this.byId.get(target)!;
          this.byId.set(target, {
            ...existing,
            title: entry.title ?? existing.title,
            concept: entry.concept !== "未分类" ? entry.concept : existing.concept,
            domain: entry.domain !== "其他" ? entry.domain : existing.domain,
            quality: entry.quality ?? existing.quality,
            relatedConcepts: entry.relatedConcepts,
          });
        }
      } catch {
        // card-index.json 损坏时仅用文件扫描结果
      }
    }

    this.cards.push(...this.byId.values());
  }

  /** 卡片总数。 */
  count(): number {
    this.ensureLoaded();
    return this.cards.length;
  }

  /** 全部卡片元数据。 */
  list(limit = 100): WikiCardMeta[] {
    this.ensureLoaded();
    return this.cards.slice(0, limit);
  }

  /** 按 id（相对路径）获取卡片。 */
  getById(id: string): WikiCardMeta | undefined {
    this.ensureLoaded();
    return this.byId.get(id);
  }

  /** 按 title 搜索卡片（标题包含关键词，不区分大小写）。 */
  search(keyword: string, limit = 10): WikiCardMeta[] {
    this.ensureLoaded();
    const kw = keyword.trim().toLowerCase();
    if (!kw) return [];
    return this.cards
      .filter(card => {
        if (card.title.toLowerCase().includes(kw)) return true;
        if (card.concept?.toLowerCase().includes(kw)) return true;
        if (card.domain?.toLowerCase().includes(kw)) return true;
        return false;
      })
      .slice(0, limit);
  }

  /**
   * 按目录前缀检索（prefix 为相对 wiki 根的路径前缀，如 "专利实务/说明书"；空串 = 全部）。
   * keyword 为空时按目录列出全部卡片（供清单核对/浏览）。
   */
  searchIn(prefix: string, keyword: string, limit = 10): WikiCardMeta[] {
    this.ensureLoaded();
    const normalizedPrefix = prefix.trim();
    // 前缀按路径边界匹配（避免误匹配兄弟前缀目录，如 "专利实务/说明书附图"）
    const candidates = normalizedPrefix
      ? this.cards.filter(card => card.id === normalizedPrefix || card.id.startsWith(`${normalizedPrefix}/`))
      : this.cards;
    const kw = keyword.trim().toLowerCase();
    if (!kw) return candidates.slice(0, limit);
    return candidates
      .filter(card => {
        if (card.title.toLowerCase().includes(kw)) return true;
        if (card.concept?.toLowerCase().includes(kw)) return true;
        if (card.domain?.toLowerCase().includes(kw)) return true;
        return false;
      })
      .slice(0, limit);
  }

  /** 列出目录前缀下的全部卡片（keyword 为空时按目录浏览）。 */
  listDir(prefix: string, limit = 20): WikiCardMeta[] {
    return this.searchIn(prefix, "", limit);
  }

  /** 按 concept 精确匹配（card-index 概念，如 "Bolar例外"）。 */
  byConcept(concept: string, limit = 10): WikiCardMeta[] {
    this.ensureLoaded();
    return this.cards.filter(card => card.concept?.toLowerCase() === concept.trim().toLowerCase()).slice(0, limit);
  }

  /** 按 domain 匹配（card-index 领域，如 "侵权抗辩"）。 */
  byDomain(domain: string, limit = 10): WikiCardMeta[] {
    this.ensureLoaded();
    const d = domain.trim().toLowerCase();
    return this.cards.filter(card => card.domain?.toLowerCase() === d).slice(0, limit);
  }

  /** 读取卡片正文（含元数据解析；内容缓存上限 64 条）。 */
  readCard(id: string): WikiCardContent | null {
    this.ensureLoaded();
    const meta = this.byId.get(id);
    if (!meta) return null;

    let content = this.contentCache.get(id);
    if (content === undefined) {
      const path = join(this.wikiPath, meta.relativePath);
      if (!existsSync(path)) return null;
      content = readFileSync(path, "utf8");
      if (this.contentCache.size >= MAX_CACHE_ENTRIES) {
        const first = this.contentCache.keys().next().value;
        if (first !== undefined) this.contentCache.delete(first);
      }
      this.contentCache.set(id, content);
    }

    const metadata = this.extractMetadata(content);
    return { meta, content, metadata };
  }

  /** 截断正文（供上下文注入）。 */
  formatAsContext(id: string, maxChars = 1200): string {
    const card = this.readCard(id);
    if (!card) return "";
    const title = card.meta.title;
    const body = card.content.length > maxChars ? `${card.content.slice(0, maxChars)}…（截断）` : card.content;
    return `### ${title}\n${body}`;
  }

  /** 递归扫描 .md 文件（跳过 .gitignore 类隐藏文件）。 */
  private scanMarkdownFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        results.push(...this.scanMarkdownFiles(full));
      } else if (entry.endsWith(".md") && entry !== CARD_INDEX_NAME) {
        results.push(full);
      }
    }
    return results;
  }

  /** 从相对路径推断标题（文件名去掉扩展名，路径分隔符换空格）。 */
  private titleFromFileName(id: string): string {
    const stem = this.safeFileStem(id);
    return stem.replace(/[-_]/g, " ");
  }

  /** 去扩展名 + 去除 card-index 的 id 后缀片段。 */
  private safeFileStem(id: string): string {
    return id.replace(/\.md$/, "");
  }

  /** 从卡片正文头部提取 `- 键: 值` 元数据行。 */
  private extractMetadata(content: string): Record<string, string> {
    const metadata: Record<string, string> = {};
    for (const line of content.split("\n").slice(0, 20)) {
      const match = /^-\s*([^:：]+)[:：]\s*(.+)$/.exec(line.trim());
      if (match) metadata[match[1].trim()] = match[2].trim();
    }
    return metadata;
  }
}
