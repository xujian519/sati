function normalize(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s\-:/]/g, "");
}

/**
 * Open a Google Patents patent page by number and return bibliographic
 * metadata. Uses schema.org itemprop attributes when present, with class-based
 * fallbacks for older page layouts.
 */
export async function getPatentMetadata(ctx, args = {}) {
  const patent = normalize(args.patent);
  if (!patent) throw new Error("patent number is required");

  await ctx.browser.openOrReuseTab(
    `https://patents.google.com/patent/${encodeURIComponent(patent)}`,
    { wait: true, timeout: 30 },
  );
  await ctx.page.waitForLoadState("load");

  return ctx.page.evaluate(() => {
    const text = (sel) => {
      const el = document.querySelector(sel);
      return el && el.innerText ? el.innerText.trim() : "";
    };
    const href = (sel) => {
      const el = document.querySelector(sel);
      return el && el.getAttribute ? el.getAttribute("href") || "" : "";
    };
    return {
      title: text("h1"),
      patent: text("[itemprop='publicationNumber']") || text(".publication_number"),
      inventors: [...document.querySelectorAll("[itemprop='inventor']")]
        .map((el) => el.innerText.trim())
        .filter(Boolean),
      assignee: text("[itemprop='assigneeOriginal']") || text(".assignee"),
      filingDate: text("[itemprop='filingDate']") || text(".filing_date"),
      publicationDate: text("[itemprop='publicationDate']") || text(".publication_date"),
      priorityDate: text("[itemprop='priorityDate']") || text(".priority_date"),
      status: text("[itemprop='status']") || text(".status"),
      abstract: text("[itemprop='abstract']") || text(".abstract"),
      pdfUrl: href("a[href*='.pdf']"),
    };
  });
}
