/**
 * OpenAlex 连接器（开放学术图谱，免费无 key）。
 *
 * 摘要以 `abstract_inverted_index`（词 → 位置）到达，重建为纯文本。
 * `mailto` 参数将请求纳入 polite pool（更快、配额更高），无 key 也能用；
 * 可选 `OPENALEX_MAILTO` 环境变量覆盖默认值。
 */
import type { Connector, ConnectorHit } from "../../protocol/types.js";
import { getJSON } from "../http.js";
import { fromInverted, raw, snippet } from "../shared/text.js";

const BASE = "https://api.openalex.org/works";
const DEFAULT_MAILTO = "sati@users.noreply.github.com";

export interface CreateOpenAlexConnectorOptions {
  /** polite pool 标识邮箱；默认回退 OPENALEX_MAILTO 环境变量。 */
  mailto?: string;
  fetchImpl?: typeof fetch;
}

interface Authorship {
  author?: { display_name?: string };
}

interface Location {
  source?: { display_name?: string };
  landing_page_url?: string;
}

interface Work {
  id?: string;
  doi?: string;
  title?: string;
  display_name?: string;
  publication_year?: number;
  cited_by_count?: number;
  abstract_inverted_index?: Record<string, number[]> | null;
  authorships?: Authorship[];
  primary_location?: Location;
  relevance_score?: number;
}

interface SearchResponse {
  results?: Work[];
  meta?: { count?: number };
}

function shortId(id?: string): string {
  return (id ?? "").replace(/^https?:\/\/openalex\.org\//i, "");
}

function authors(w: Work): string | undefined {
  const names = (w.authorships ?? []).map(a => a.author?.display_name).filter((n): n is string => !!n);
  if (names.length === 0) return undefined;
  return names.length > 4 ? `${names.slice(0, 4).join(", ")} et al.` : names.join(", ");
}

function toHit(w: Work): ConnectorHit {
  const meta = [authors(w), w.primary_location?.source?.display_name, w.publication_year].filter(Boolean).join(". ");
  return {
    id: shortId(w.id) || (w.doi ?? ""),
    title: snippet(w.display_name ?? w.title, 300) ?? (shortId(w.id) || "Untitled"),
    summary: snippet(fromInverted(w.abstract_inverted_index)) ?? (meta.length ? meta : undefined),
    url: w.id ?? w.primary_location?.landing_page_url ?? w.doi ?? undefined,
    score: typeof w.relevance_score === "number" ? w.relevance_score : w.cited_by_count,
    extra: raw(w),
  };
}

export function createOpenAlexConnector(options: CreateOpenAlexConnectorOptions = {}): Connector {
  const polite = (): string => {
    const email = options.mailto?.trim() || process.env.OPENALEX_MAILTO?.trim() || DEFAULT_MAILTO;
    return `mailto=${encodeURIComponent(email)}`;
  };
  return {
    id: "openalex",
    name: "OpenAlex",
    domain: "literature",
    description: "Open scholarly graph of works, authors, venues, and concepts (successor to MAG).",
    homepage: "https://openalex.org",
    async search(query, opts) {
      const per = Math.min(Math.max(opts?.limit ?? 10, 1), 50);
      const data = await getJSON<SearchResponse>(
        `${BASE}?search=${encodeURIComponent(query)}&per-page=${per}&${polite()}`,
        { signal: opts?.signal, fetchImpl: options.fetchImpl },
      );
      return (data.results ?? []).map(toHit);
    },
    async fetch(id, opts) {
      // OpenAlex 接受裸 work id（W…）或 DOI 原样路径段（"works/doi:10.x/y"）；
      // DOI 的斜杠/冒号不能编码。
      const path = /^10\.\d/.test(id) ? `doi:${id}` : encodeURIComponent(shortId(id) || id);
      const data = await getJSON<Work>(`${BASE}/${path}?${polite()}`, {
        signal: opts?.signal,
        fetchImpl: options.fetchImpl,
      });
      return data ?? null;
    },
  };
}
