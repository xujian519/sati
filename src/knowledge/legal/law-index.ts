/**
 * src/knowledge/legal — 法规索引（从 knowledge.db **现算**，供法条引用核验）。
 *
 * 上游 dsh 的 `patent-law` 用**随包资产**声明索引（`maxArticle` / `topics` 都是人工填的字段）。
 * Sati 侧没有这份资产，索引必须从知识库里现算——本模块做这件事，并把**选源过程**留下痕迹。
 *
 * 三处 Sati 特有的事实（改动前请先读）：
 *
 * 1. **同一部法在库里有多个来源**：实测 `doc_type='law_article'` 且标题含「专利法」的文档共 10 条——
 *    2 条 `source='raw'` 全文（专利法 82 条 / 实施细则 149 条）+ 8 条 `source='wiki'` 碎片。
 *    若只按标题模糊匹配就取第一条，会把碎片当全文 ⇒ 上界判定崩坏。故按 **`1..N` 连续上界最大**
 *    选权威源，并把候选与落选原因一并写进报告（选源本身是一次判定，不许静默）。
 * 2. **正文不在 `documents` 表里**：`documents` 只有元数据，正文在 `chunks.content`，且一条 chunk 是
 *    「按大小合并的块」（一条可含多条法条）。故取全文必须 `ORDER BY chunk_index` 拼接**全部** chunk——
 *    复用 `KnowledgeLawSearch.getById/findByName` 拿不到全文：那两条语句是
 *    `ORDER BY char_count DESC LIMIT 1`，只取**最大的单个 chunk**（实测专利法的最大 chunk 仅 498 字，
 *    全文 11 318 字分散在 27 条 chunk 里）。
 * 3. **法名靠归一化对齐，不靠前缀硬编码**：引用写「专利法」「《中华人民共和国专利法》」，
 *    库里标题写「中华人民共和国专利法（2020年修正）」。归一化（去书名号 / 去「中华人民共和国」/
 *    去括号后缀 / 去破折号后缀）后才是可比的法名。
 *    ⚠️ 归一化必须**先做再比**：`title LIKE '%专利法%'` 会同时命中「专利法实施细则」
 *    （它含「专利法」三字），而它的 149 条比专利法的 82 条多——直接取 maxContig 最大者会**错选**。
 */

import type { DatabaseSync } from "node:sqlite";
import { resolveKnowledgeDbPaths } from "../config.js";
import { decompressChunk, registerChunkUncompress } from "../shared/chunk-compression.js";
import { openKnowledgeDb } from "../shared/db-version.js";
import { KNOWLEDGE_DB } from "../shared/schema-versions.js";
import { splitLawIntoArticles } from "./article-parser.js";

/** 一条已索引的法条。 */
export type IndexedArticle = {
  /** 母条号（阿拉伯数字；「第N条之M」的子条归入母条 N）。 */
  number: number;
  /** 条文正文（含条号同行的剩余部分与后续行）。 */
  text: string;
};

/** 一个候选法源的扫描结果（写进报告，供「为什么选了它」复核）。 */
export type LawSourceCandidate = {
  documentId: string;
  title: string;
  source: string;
  charCount: number;
  /** 切出的母条数。 */
  articleCount: number;
  /** `1..N` 全部在场所能取到的最大 N（0 = 未能证明上界）。 */
  maxContig: number;
};

/** 一部法的索引条目。 */
export type LawEntry = {
  /** 归一化法名（如「专利法」/「专利法实施细则」）。 */
  law: string;
  /** 选中的权威源 documentId。 */
  documentId: string;
  /** 权威源的原始标题（报告里给可读标注）。 */
  documentTitle: string;
  source: string;
  /** 连续上界：条号 `1..maxArticle` 全部在场。`0` 表示**未能证明**上界（不得据此判 `out-of-range`）。 */
  maxArticle: number;
  articles: Map<number, IndexedArticle>;
  /** 同法名的全部候选（含落选者），按扫描顺序。 */
  candidates: LawSourceCandidate[];
};

/** 索引全集。 */
export type LawIndex = {
  /** 归一化法名 → 条目。 */
  entries: Map<string, LawEntry>;
  /** 全部法名，**按长度降序**（抽取引用时长的优先匹配，避免「专利法」抢走「专利法实施细则」）。 */
  lawNames: string[];
};

/**
 * 归一化法名：去书名号 / 去「中华人民共和国」前缀 / 去**章节与序号前缀** / 去括号后缀 / 去破折号后缀。
 *
 * 例：「中华人民共和国专利法（2020年修正）」→「专利法」；
 * 「专利法实施细则（2023年修订）— 审查批准与复审无效（第37-69条）」→「专利法实施细则」；
 * 「一、山东省专利条例（2025年修订）」→「山东省专利条例」。
 *
 * ⚠️ 剥前缀不是美化：库里有「一、山东省专利条例」（wiki，0 条）与「山东省专利条例」（raw，33 条）
 * 两份同法文档。不剥前缀 → 两者法名不同 → 抽引用时更长的带前缀名优先命中 → 合法条号被判
 * `not-indexed`，而真相是**同一部法的另一份来源里有全文**。
 */
export function normalizeLawName(title: string): string {
  return (
    title
      .replace(/[《》]/g, "")
      .replace(/^中华人民共和国/, "")
      .replace(/^第[〇零一二三四五六七八九十百0-9]+[章节]\s*/, "")
      .replace(/^[〇零一二三四五六七八九十0-9]+[、.]\s*/, "")
      .replace(/[（(][^）)]*[）)]/g, "")
      .split(/[—–\-]/)[0]
      ?.trim() ?? ""
  );
}

/**
 * 法名是否「像一部法规」——用于挑出可被引用识别的法名。
 *
 * 判据：以中国法规名称的固定后缀结尾（法 / 条例 / 办法 / 规定 / 细则 / 规则 / 标准 /
 * 解释 / 批复 / 指南 / 通知 / 决定 / 命令 / 规程）。
 *
 * 为什么需要它：`doc_type='law_article'` 里混着**语料片段**（实测 60 个「法名」中包括
 * `CLAUDE.md`、`分拆目录`、`条文与解读`、`与其他知识库的关联`、`第五章 商标相同、近似的审查审理`）。
 * 它们进不了引用位置，却会污染法名正则、并在报告里冒充法规。
 *
 * 判据取「后缀白名单」而非「关键词黑名单」：黑名单永远漏，而中国法规名称的后缀是封闭集。
 * 书名号路径（`《任意名》第N条`）**不过此判据**——否则编造法名会被静默忽略而不是报 `not-indexed`。
 */
export function isLawLikeName(name: string): boolean {
  return /(法|条例|办法|规定|细则|规则|标准|解释|批复|指南|通知|决定|命令|规程)$/.test(name);
}

/** `1..N` 全在场时的最大 N（输入为已观测到的条号集合）。 */
export function maxContiguousArticle(numbers: ReadonlySet<number>): number {
  let n = 0;
  while (numbers.has(n + 1)) n += 1;
  return n;
}

/** 从 chunks 取一个文档的全文（按 chunk_index 拼接；压缩 chunk 先解压）。 */
function readFullText(db: DatabaseSync, documentId: string): string {
  const rows = db
    .prepare("SELECT content FROM chunks WHERE document_id = ? ORDER BY chunk_index")
    .all(documentId) as Array<{ content: unknown }>;
  return rows.map(row => decompressChunk(row.content as string | Uint8Array | null)).join("\n");
}

/** 把一个文档切成条号 → 条文。 */
function parseArticles(fullText: string): Map<number, IndexedArticle> {
  const articles = new Map<number, IndexedArticle>();
  for (const fragment of splitLawIntoArticles(fullText)) {
    if (fragment.sub !== undefined) continue; // 子条（第N条之M）归入母条
    const number = Number(fragment.base.replace(/[^0-9]/g, ""));
    if (!Number.isInteger(number) || number < 1) continue;
    if (!articles.has(number)) articles.set(number, { number, text: fragment.content });
  }
  return articles;
}

/**
 * 从已打开的 knowledge.db 构建法规索引（纯读；不写库）。
 *
 * 全部 `doc_type='law_article'` 文档都参与，按归一化法名分组，每组取 `maxContig` 最大者为权威源。
 */
export function buildLawIndex(db: DatabaseSync): LawIndex {
  const docs = db
    .prepare(
      "SELECT id, title, source, char_count FROM documents WHERE doc_type = 'law_article' ORDER BY char_count DESC",
    )
    .all() as Array<{ id: string; title: string; source: string; char_count: number }>;

  const byLaw = new Map<string, LawSourceCandidate[]>();
  const bodies = new Map<string, { articles: Map<number, IndexedArticle>; maxContig: number }>();

  for (const doc of docs) {
    const law = normalizeLawName(doc.title);
    if (law === "") continue;
    const articles = parseArticles(readFullText(db, doc.id));
    const maxContig = maxContiguousArticle(new Set(articles.keys()));
    const candidate: LawSourceCandidate = {
      documentId: doc.id,
      title: doc.title,
      source: doc.source,
      charCount: doc.char_count,
      articleCount: articles.size,
      maxContig,
    };
    const list = byLaw.get(law);
    if (list === undefined) byLaw.set(law, [candidate]);
    else list.push(candidate);
    bodies.set(doc.id, { articles, maxContig });
  }

  const entries = new Map<string, LawEntry>();
  for (const [law, candidates] of byLaw) {
    let best:
      | { candidate: LawSourceCandidate; body: { articles: Map<number, IndexedArticle>; maxContig: number } }
      | undefined;
    for (const candidate of candidates) {
      const body = bodies.get(candidate.documentId);
      if (body === undefined) continue;
      if (best === undefined || candidate.maxContig > best.candidate.maxContig) best = { candidate, body };
    }
    if (best === undefined) continue;
    entries.set(law, {
      law,
      documentId: best.candidate.documentId,
      documentTitle: best.candidate.title,
      source: best.candidate.source,
      maxArticle: best.body.maxContig,
      articles: best.body.articles,
      candidates,
    });
  }

  // 抽取用的法名只要「像法规」的（见 `isLawLikeName`）；`entries` 仍保留全部，
  // 以便对「未收录」与「已收录但未按条号切分」给出不同理由（降级不静默）。
  const lawNames = [...entries.keys()].filter(isLawLikeName).sort((a, b) => b.length - a.length);
  return { entries, lawNames };
}

/** 索引构建结果（含库路径，供报告与降级说明）。 */
export type LoadedLawIndex = { index: LawIndex; dbPath: string };

/**
 * 定位并构建法规索引。
 *
 * 返回 `undefined` 表示**知识库不可用**（未配置 / 打不开）——调用方必须据此降级为
 * `setup_required`，**绝不允许**当成「没有发现错误」而放行引用（见 `law-verify.ts` 的降级约定）。
 */
export function loadLawIndex(env: NodeJS.ProcessEnv = process.env): LoadedLawIndex | undefined {
  const dbPath = resolveKnowledgeDbPaths(env).knowledgeDb;
  if (dbPath === undefined) return undefined;
  try {
    const opened = openKnowledgeDb(dbPath, KNOWLEDGE_DB, { readOnly: true });
    const db = opened.db;
    try {
      registerChunkUncompress(db);
      return { index: buildLawIndex(db), dbPath };
    } finally {
      db.close();
    }
  } catch {
    // 库打不开（文件损坏 / 版本戳来自未来 / 根本不是 knowledge.db）一律当「不可用」返回 undefined，
    // 由调用方降级为 setup_required。**不在此处吞掉后假装索引为空**——那会让每一次引用核验
    // 都落进「没有发现问题」的假象里。
    return undefined;
  }
}
