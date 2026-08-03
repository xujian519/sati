/**
 * arXiv 连接器（Atom XML 查询 API，免费无 key）。
 *
 * 设计引入自 OpenScience connectors/literature/arxiv.ts：
 *   - 限速 1 req/3s（arXiv 官方要求，per-host 由 http 层强制）；
 *   - fielded 查询（ti:/au:/cat:...）透传，否则 `all:` 包裹；
 *   - 防御式解析：非 Atom body、arXiv 的 200+Error 假条目都按错误处理，
 *     绝不当作命中（源错误 ≠ 无结果）。
 * `fetch` 用 `id_list` 形式精确取记录。
 */
import type { Connector, ConnectorHit } from "../../protocol/types.js";
import { getText, type LiteratureFetchOptions, type LiteratureRateLimit } from "../http.js";
import type { NetworkRetryOptions } from "../../../network/fetch.js";
import { raw, snippet } from "../shared/text.js";
import { xmlAttr, xmlBlocks, xmlSelfClosing, xmlText } from "../shared/xml.js";

const BASE = "https://export.arxiv.org/api/query";
const RATE_LIMIT = { minIntervalMs: 3000 };

/** arXiv 认识的查询字段前缀；命中即视为已 fielded，透传不包裹。 */
const FIELDED = /^(ti|au|abs|co|jr|cat|rn|id|all):/i;

export interface CreateArxivConnectorOptions {
  fetchImpl?: typeof fetch;
  /** 覆盖默认 3s per-host 限速（测试注入小值/0）。 */
  rateLimit?: LiteratureRateLimit;
  /** 覆盖重试配置（测试注入 maxRetries: 0 跳过退避等待）。 */
  retry?: NetworkRetryOptions;
}

interface Entry {
  id: string;
  title?: string;
  summary?: string;
  published?: string;
  authors: string[];
  primaryCategory?: string;
  pdf?: string;
  raw: string;
}

function bareId(idUrl: string): string {
  return idUrl.replace(/^https?:\/\/arxiv\.org\/abs\//i, "").trim();
}

/** 真正的 Atom feed 以 `<feed …>` 开头；HTML 错误页 / 空 body 不是。 */
function isAtomFeed(xml: string): boolean {
  return /<feed[\s>]/i.test(xml);
}

/** arXiv 对畸形查询/ id 返回 200 + 单个 id 指向 …/api/errors、标题为 "Error" 的条目。 */
function isErrorEntry(e: Entry): boolean {
  return e.id.startsWith("http://arxiv.org/api/errors") || e.title === "Error";
}

/** 裸查询包 `all:`；已 fielded 的查询原样透传。 */
function searchExpr(query: string): string {
  const q = query.trim();
  return FIELDED.test(q) ? q : `all:${q}`;
}

function parse(xml: string): Entry[] {
  return xmlBlocks(xml, "entry").map(block => {
    const id = xmlText(block, "id") ?? "";
    const authors = xmlBlocks(block, "author")
      .map(a => xmlText(a, "name"))
      .filter((n): n is string => !!n);
    // arXiv 的 PDF 链接是自闭合的 `<link title="pdf" href="…" …/>`，没有
    // `</link>` 配对标签，配对的 block helper 看不见它——用 xmlSelfClosing。
    const pdf = xmlSelfClosing(block, "link").find(l => (l.attrs.title ?? "").toLowerCase() === "pdf")?.attrs.href;
    return {
      id,
      title: xmlText(block, "title"),
      summary: xmlText(block, "summary"),
      published: xmlText(block, "published"),
      authors,
      primaryCategory: xmlAttr(block, "arxiv:primary_category", "term"),
      pdf,
      raw: block,
    };
  });
}

/**
 * 拉取并校验一次 arXiv Atom 响应。非 Atom body 与 arXiv 错误条目一律抛错
 * （而非返回 `[]`），让工具层能区分"源错误"与"真零结果"。
 */
async function feed(url: string, http: LiteratureFetchOptions): Promise<Entry[]> {
  // rateLimit/retry/fetchImpl 已在连接器构造时并入 http；signal 每次调用可变。
  const xml = await getText(url, { ...http, looksValid: isAtomFeed });
  if (!isAtomFeed(xml)) {
    throw new Error("arXiv returned a non-Atom response (likely rate-limited or unavailable); retry shortly.");
  }
  const entries = parse(xml);
  const bad = entries.find(isErrorEntry);
  if (bad) throw new Error(`arXiv rejected the query: ${bad.summary ?? bad.title ?? "malformed request"}`);
  return entries;
}

function toHit(e: Entry): ConnectorHit {
  const id = bareId(e.id);
  const who = e.authors.length > 4 ? `${e.authors.slice(0, 4).join(", ")} et al.` : e.authors.join(", ");
  const meta = [who, e.primaryCategory, e.published?.slice(0, 10)].filter(Boolean).join(". ");
  return {
    id,
    title: snippet(e.title, 300) ?? id,
    summary: snippet(e.summary) ?? (meta.length ? meta : undefined),
    url: e.id || `https://arxiv.org/abs/${id}`,
    // Entry.pdf（自闭合 link 解析结果）随 raw(e) 原样进入 extra，工具层读 extra.pdf。
    extra: raw(e),
  };
}

export function createArxivConnector(options: CreateArxivConnectorOptions = {}): Connector {
  const http: LiteratureFetchOptions = {
    fetchImpl: options.fetchImpl,
    rateLimit: options.rateLimit ?? RATE_LIMIT,
    retry: options.retry,
  };
  return {
    id: "arxiv",
    name: "arXiv",
    domain: "literature",
    description: "Open-access preprints in physics, math, CS, quantitative biology, and more.",
    homepage: "https://arxiv.org",
    async search(query, opts) {
      const max = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
      const url = `${BASE}?search_query=${encodeURIComponent(searchExpr(query))}&start=0&max_results=${max}&sortBy=relevance`;
      const entries = await feed(url, { ...http, signal: opts?.signal });
      return entries.map(toHit);
    },
    async fetch(id, opts) {
      const clean = bareId(id);
      const entries = await feed(`${BASE}?id_list=${encodeURIComponent(clean)}&max_results=1`, {
        ...http,
        signal: opts?.signal,
      });
      return entries[0] ?? null;
    },
  };
}
