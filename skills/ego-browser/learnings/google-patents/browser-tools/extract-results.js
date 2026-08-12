async function (args) {
  const limit = Math.max(1, Math.min(50, Number(args.maxResults) || 10));
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
  return [...document.querySelectorAll("search-result")]
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
}
