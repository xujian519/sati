function boundedInteger(value, fallback, max) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(number)));
}

/**
 * Search Google Patents by keyword/boolean query and return top hits.
 * Google Patents renders results asynchronously (SPA); this tool waits for
 * `search-result` elements before extracting.
 */
export async function searchPatents(ctx, args = {}) {
  const query = String(args.query || "").trim();
  const maxResults = boundedInteger(args.maxResults, 10, 50);
  if (!query) throw new Error("search query is required");

  await ctx.browser.openOrReuseTab(
    `https://patents.google.com/?q=${encodeURIComponent(query)}`,
    { wait: true, timeout: 30 },
  );
  await ctx.page.waitForLoadState("load");
  // SPA：结果异步渲染，等待 search-result 出现（容错：超时不抛，空结果由调用方判定）
  await ctx.page
    .locator("search-result")
    .first()
    .waitFor({ timeout: 20000 })
    .catch(() => {});

  return ctx.page
    .locator("search-result")
    .evaluateAll((items, limit) => {
      const pick = (root, selectors) => {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          if (el && el.innerText && el.innerText.trim()) return el.innerText.trim();
        }
        return "";
      };
      const pickHref = (root, selectors) => {
        for (const sel of selectors) {
          const el = root.querySelector(sel);
          if (el && el.getAttribute && el.getAttribute("href")) return el.getAttribute("href");
        }
        return "";
      };
      return items
        .slice(0, limit)
        .map((el) => ({
          title: pick(el, ["h3.result-title", ".title-text", "h3"]),
          patent: pick(el, [".publication_number", ".num", "[itemprop='publicationNumber']"]),
          url: pickHref(el, ["a[href*='/patent/']"]),
          assignee: pick(el, [".assignee", ".assignee-info", "[itemprop='assigneeOriginal']"]),
          pubDate: pick(el, [".priority_date", ".filing_date", "time", "[itemprop='publicationDate']"]),
          abstract: pick(el, [".abstract", ".snippet", ".result-abstract", "[itemprop='abstract']"]),
        }))
        .filter((r) => r.title || r.patent);
    }, maxResults);
}
