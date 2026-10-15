/**
 * src/knowledge/legal — 法条引用核验（决策层）。
 *
 * 决策枚举逐字对齐上游 dsh `packages/patent/patent-law/src/verify.ts` 的 `CitationDecision`，
 * 因为这套词汇已用于描述 Sati 的缺口，改词会让两份文档对不上。
 *
 * ## 这个工具拦得住什么、拦不住什么（工具描述必须照抄这段）
 *
 * 它是**引用形式门禁**，不是命题正确性门禁：
 *
 * - **拦得住**：编造的条号（超出该法条数）、未收录的法名、库里有法但未按条号切分、正文确实不含的命题。
 * - **拦不住**：条号与命题**不符但共享常见词**。判据是「命题与条文正文共享任一 3-gram」，
 *   任何含「创造性」「权利要求」「申请人」等常见法律词的无关命题都会判 `valid`。
 *   上游 dsh 用人工整理的主题词表（`ArticleEntry.topics`）做同一件事，同样宽松——它的注释里
 *   明说命中任一主题词即算通过。唯一的补偿是**重合强度会如实报出**（如「仅重合 1/17 个片段」）。
 *   要判「该条是否真支撑该论断」，须由更强判据（如 `evaluate_evidence` 链路）承担，
 *   本模块不假装能承担。
 * - **`mismatch` 只在零重合时触发**，不要期待它拦住同义改写：实测「与在先技术相较，本发明呈现出
 *   非显而易见性」对专利法第 22 条仍共享「技术相」这一个片段（1/17），按判据判 `valid`。
 *   真正的 `mismatch` 意味着命题与该条连一个三字片段都不共享——那更可能是引错了条。
 * - **条文抄录是否正确**不可由运行时证伪：索引来自知识库管道产物，本模块只能证明
 *   「条号连续」与「正文里有没有这些字」，不能证明「库里那几行字与官方文本一致」。
 */

import { cnToArabic } from "./article-parser.js";
import type { LawIndex } from "./law-index.js";

/** 一条法条引用（当前只支持法条；指南章节见文件末的说明）。 */
export type LawArticleReference = {
  kind: "law-article";
  /** 归一化法名（如「专利法」「专利法实施细则」）。 */
  law: string;
  /** 母条号。 */
  article: number;
  /** 款号（引用写明了才有）。 */
  paragraph?: number;
  /** 项号（引用写明了才有）。 */
  item?: number;
  /** 引用原文（保留写法，供报告定位）。 */
  raw: string;
};

/** 引用形态（当前仅有法条一种）。 */
export type LawReference = LawArticleReference;

/** 一条引用的判定。 */
export type CitationDecision =
  /** 条号在收录集内，且（给了命题时）命题与条文正文有共同表述。 */
  | "valid"
  /** 条号存在，但命题与条文正文无共同表述。 */
  | "mismatch"
  /** 超出该法**已证明**的条号上界。 */
  | "out-of-range"
  /** 索引里没有（法名未收录 / 该条未切出 / 上界未能证明）。 */
  | "not-indexed"
  /** 条号可解析，但该法的权威来源未经核验（非管道全文）。 */
  | "unverified";

/** 一条引用的判定结果。 */
export type CitationFinding = {
  raw: string;
  reference: LawReference;
  decision: CitationDecision;
  /** 人读理由（含实测值；`not-indexed` 必须写明是"未收录"还是"未切分"）。 */
  reason: string;
  /** 命中的索引事实（命中时给出，供报告与复核）。 */
  entry?: { law: string; article: number; documentTitle: string; maxArticle: number };
};

/** 命题与条文正文的匹配结论。 */
export type PropositionVerdict = "match" | "mismatch" | "undecidable";

/** 命题匹配的实测证据（重合片段数 / 命题片段总数）。 */
export type PropositionEvidence = { shared: number; total: number };

/** 数字串（中文数字或阿拉伯数字），限长以防超长误匹配。 */
const NUMBER = "[〇零一二三四五六七八九十百0-9]{1,6}";

/** 书名号路径：`《任意法名》第N条[第M款][第K项]`。 */
const BOOK_MARK_PATTERN = new RegExp(
  `《([^》]{1,40})》\\s*第?(${NUMBER})条(?:第(${NUMBER})款)?(?:第(${NUMBER})项)?`,
  "g",
);

/** 转义正则元字符（法名一般是中文，但库里的脏数据什么都可能有）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** n-gram 长度（与 FTS trigram 同口径，3 是中文里最短的有意义片段）。 */
const NGRAM = 3;

/** 归一化用于 n-gram 比较的文本：只留中文与字母数字。 */
function normalizeForMatch(text: string): string {
  return text.replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, "");
}

/** 取文本的全部 3-gram。 */
function trigrams(text: string): Set<string> {
  const normalized = normalizeForMatch(text);
  const grams = new Set<string>();
  for (let i = 0; i + NGRAM <= normalized.length; i += 1) grams.add(normalized.slice(i, i + NGRAM));
  return grams;
}

/**
 * 判定命题与条文正文的关系，连同**重合强度**一起给出。
 *
 * 判据是「命题与条文正文是否共享任一 3-gram」（宽松，与上游 dsh 的「命中任一主题词即通过」同口径）。
 * 但**宽松到什么程度必须让调用方看得见**——实测三种真实命题对专利法第 22 条：
 *
 * | 命题 | 共享片段 | 比值 |
 * |---|---|---|
 * | 逐字引自该条 | 29 / 29 | 1.00 |
 * | 同义改写（「与在先技术相较…非显而易见性」） | 1 / 17 | 0.06 |
 * | 无关但含「创造性」一词 | 1 / 16 | 0.06 |
 * | 与该条毫无共同字 | 0 / 10 | 0 |
 *
 * 可见「1 个片段命中」既可能是同义改写、也可能是碰巧共享「技术相」这类通用片段——
 * 把它当强证据是错的，但把它判成 `mismatch`（block 级）又是误伤。故：
 * **只在零重合时判 `mismatch`**，有重合一律 `match`，同时把 `shared/total` 交出去，
 * 让调用方自己判断这条「通过」有多硬。
 *
 * 命题短于 3 字时无法机械判定，返回 `undecidable`——不据此判 `mismatch`。
 */
export function evaluateProposition(
  articleText: string,
  proposition: string | undefined,
): { verdict: PropositionVerdict; evidence: PropositionEvidence } {
  if (proposition === undefined || proposition.trim() === "") {
    return { verdict: "match", evidence: { shared: 0, total: 0 } };
  }
  const needle = trigrams(proposition);
  if (needle.size === 0) return { verdict: "undecidable", evidence: { shared: 0, total: 0 } };
  const haystack = trigrams(articleText);
  let shared = 0;
  for (const gram of needle) {
    if (haystack.has(gram)) shared += 1;
  }
  return {
    verdict: shared > 0 ? "match" : "mismatch",
    evidence: { shared, total: needle.size },
  };
}

/** 命题匹配的一句话附注（把「这次通过有多硬」如实交出去，不假装它等于语义支撑）。 */
export function describePropositionMatch(verdict: PropositionVerdict, evidence: PropositionEvidence): string {
  if (verdict === "undecidable") return "；命题过短，未做字面比对";
  if (evidence.total === 0) return ""; // 没给命题，只核了条号
  if (evidence.shared * 2 >= evidence.total) {
    return `；命题与条文重合 ${evidence.shared}/${evidence.total} 个三字片段`;
  }
  return `；命题与条文仅重合 ${evidence.shared}/${evidence.total} 个三字片段（可能只是巧合或同义改写，**不足以据此认定该条支撑该命题**）`;
}

/** 一个待判定的候选（带 span，供重叠消解）。 */
type Candidate = { start: number; end: number; reference: LawReference };

/** 由正则匹配结果构造引用（数字不可解析时返回 null）。 */
function toReference(input: {
  law: string;
  article: string;
  paragraph?: string;
  item?: string;
  raw: string;
}): LawReference | null {
  const article = cnToArabic(input.article);
  if (!Number.isInteger(article) || article < 1) return null;
  const paragraph = input.paragraph === undefined ? null : cnToArabic(input.paragraph);
  const item = input.item === undefined ? null : cnToArabic(input.item);
  return {
    kind: "law-article",
    law: input.law,
    article,
    ...(paragraph !== null && Number.isInteger(paragraph) && paragraph >= 1 ? { paragraph } : {}),
    ...(item !== null && Number.isInteger(item) && item >= 1 ? { item } : {}),
    raw: input.raw,
  };
}

/**
 * 抽取文本里的全部法条引用（按出现顺序，重叠与重复只留一个）。
 *
 * 两路并用，各有不可替代的作用：
 * - **书名号路径**（`《任意名》第N条`）：不依赖索引 ⇒ 编造的法名也能被抽出并判 `not-indexed`。
 *   只用法名表的话，未收录的法名会被**静默忽略**（连 finding 都没有）——那比判错更糟。
 * - **库内法名路径**（`专利法第二十二条`，不写书名号）：这类引用在实务文书里极常见，
 *   但它没有书名号做边界，只能靠已知法名匹配；法名表按长度降序，避免「专利法」抢走「专利法实施细则」。
 */
export function extractLawReferences(text: string, lawNames: readonly string[]): LawReference[] {
  const candidates: Candidate[] = [];

  for (const match of text.matchAll(BOOK_MARK_PATTERN)) {
    const reference = toReference({
      law: match[1]!.trim(),
      article: match[2]!,
      ...(match[3] === undefined ? {} : { paragraph: match[3] }),
      ...(match[4] === undefined ? {} : { item: match[4] }),
      raw: match[0],
    });
    if (reference !== null) candidates.push({ start: match.index, end: match.index + match[0].length, reference });
  }

  if (lawNames.length > 0) {
    const pattern = new RegExp(
      `(?:${lawNames.map(escapeRegExp).join("|")})\\s*》?\\s*第?(${NUMBER})条(?:第(${NUMBER})款)?(?:第(${NUMBER})项)?`,
      "g",
    );
    for (const match of text.matchAll(pattern)) {
      const raw = match[0];
      // 法名是匹配文本的前缀，去掉尾随的 》/空白/条号部分。
      const law = raw.replace(new RegExp(`\\s*》?\\s*第?${NUMBER}条.*$`), "").trim();
      const reference = toReference({
        law,
        article: match[1]!,
        ...(match[2] === undefined ? {} : { paragraph: match[2] }),
        ...(match[3] === undefined ? {} : { item: match[3] }),
        raw,
      });
      if (reference !== null) candidates.push({ start: match.index, end: match.index + raw.length, reference });
    }
  }

  // 重叠消解：先按起点、再按更长的在前（书名号路径比库内法名路径多含「《」，同起点时它更完整）。
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const accepted: Candidate[] = [];
  for (const candidate of candidates) {
    if (accepted.some(other => candidate.start < other.end && other.start < candidate.end)) continue;
    accepted.push(candidate);
  }

  const seen = new Set<string>();
  const references: LawReference[] = [];
  for (const candidate of accepted) {
    if (seen.has(candidate.reference.raw)) continue;
    seen.add(candidate.reference.raw);
    references.push(candidate.reference);
  }
  return references;
}

/**
 * 判定一条引用。
 *
 * `not-indexed` 的三种来源必须可区分（这是本模块最容易被误读的地方）：
 * 1. 法名未收录；
 * 2. 法名已收录但该来源**未能证明条号上界**（`maxArticle === 0`，库里是摘要/碎片而非全文）；
 * 3. 上界已证明、但该条在切分中缺失。
 *
 * ⚠️ 第 2 种**不得**判 `out-of-range`：上界未能证明时说"超过上界"是**编造一个我们不知道的事实**。
 */
export function verifyCitation(reference: LawReference, index: LawIndex, proposition?: string): CitationFinding {
  const entry = index.entries.get(reference.law);
  if (entry === undefined) {
    return {
      raw: reference.raw,
      reference,
      decision: "not-indexed",
      reason: `知识库未收录《${reference.law}》（已收录 ${index.entries.size} 部法规，多为专利/商标领域）`,
    };
  }

  if (entry.maxArticle === 0) {
    return {
      raw: reference.raw,
      reference,
      decision: "not-indexed",
      reason: `《${reference.law}》已收录（${entry.documentTitle}），但该来源未按「第N条」切分，**本次未能证明条号上界**，无法判定第 ${reference.article} 条`,
    };
  }

  if (reference.article > entry.maxArticle) {
    return {
      raw: reference.raw,
      reference,
      decision: "out-of-range",
      reason: `《${reference.law}》共 ${entry.maxArticle} 条（来源：${entry.documentTitle}），不存在第 ${reference.article} 条`,
    };
  }

  const article = entry.articles.get(reference.article);
  if (article === undefined) {
    return {
      raw: reference.raw,
      reference,
      decision: "not-indexed",
      reason: `《${reference.law}》第 ${reference.article} 条未在索引中切出（上界 ${entry.maxArticle} 已证明，说明该条在切分中缺失）`,
    };
  }

  const hit = {
    law: entry.law,
    article: reference.article,
    documentTitle: entry.documentTitle,
    maxArticle: entry.maxArticle,
  };
  const { verdict, evidence } = evaluateProposition(article.text, proposition);
  if (verdict === "mismatch") {
    return {
      raw: reference.raw,
      reference,
      decision: "mismatch",
      reason: `第 ${reference.article} 条正文与所引命题没有任何共同的三字片段（判据只看字面，不做语义判断；但同义改写通常仍会共享个别片段，落到这里更可能真是引错了条）`,
      entry: hit,
    };
  }

  const propositionNote = describePropositionMatch(verdict, evidence);
  if (entry.source !== "raw") {
    return {
      raw: reference.raw,
      reference,
      decision: "unverified",
      reason: `第 ${reference.article} 条条号成立，但该法索引来自「${entry.source}」来源而非管道全文，条文未经核验`,
      entry: hit,
    };
  }
  return {
    raw: reference.raw,
    reference,
    decision: "valid",
    reason: `第 ${reference.article} 条存在（《${entry.law}》共 ${entry.maxArticle} 条）${propositionNote}`,
    entry: hit,
  };
}

/** 抽取并逐条判定一段文本里的法条引用。 */
export function verifyCitations(text: string, index: LawIndex, proposition?: string): CitationFinding[] {
  return extractLawReferences(text, index.lawNames).map(reference => verifyCitation(reference, index, proposition));
}

/** 各决策的严重度（与 dsh 的默认 policy 对齐：越界与不符拦截，其余提示）。 */
export const DECISION_SEVERITY: Record<CitationDecision, "block" | "warn" | "allow"> = {
  valid: "allow",
  mismatch: "block",
  "out-of-range": "block",
  "not-indexed": "warn",
  unverified: "warn",
};

// 说明：上游还有 `guideline-section`（《专利审查指南》第N部分第M章…）一类引用。
// Sati 侧**未实现**，原因是形态不成立：dsh 的指南索引以章节路径为键
// （`第二部分第四章3.2.1.1`），而 Sati 知识库里指南是 `doc_type='guideline_rule'` 的
// **规则卡片**（标题形如「审查-计算机-根据专利法第25条审查」），没有章节路径体系。
// 硬做只会把「章程存在性」伪装成「章节存在性」。指南引用目前落在 `not-indexed`
// （法名未收录），工具描述里已写明这一边界。
