// Fetch one public page through ego lite and write its readable text.
//
// ego-browser runs this file from stdin with no argv and no inherited
// environment, so every input comes from an absolute-path JSON request file and
// every output path is absolute.
//
// Request fields:
//   url        (required) page to open
//   output     (required) absolute path for the JSON or text result
//   space      TaskSpace name, reused across rounds (default "legal-research")
//   page       Page label inside that space (default "p1")
//   waitFor    optional selector to wait for after load
//   timeout    wait timeout in ms (default 20000)
//   textOnly   write plain text instead of the JSON record (default false)
//
// Usage:
//   ego-browser nodejs < "$SKILL_DIR/scripts/fetch-page.mjs" 2>&1
//
// The result is written to `output`; the summary on stderr is only a receipt.

const fs = await import('node:fs/promises')
const os = await import('node:os')
const { dirname, isAbsolute, join } = await import('node:path')

// Ego scripts receive no argv and inherit no environment, so the request comes
// from a fixed file. `/tmp` is the Unix path the skill writes; `os.tmpdir()`
// covers Windows and macOS temp layouts.
const REQUEST_CANDIDATES = [
  '/tmp/dsh-legal-fetch.json',
  join(os.tmpdir(), 'dsh-legal-fetch.json'),
]

/** Read and validate the request file, then remove it. */
async function readRequest() {
  let raw
  let path
  for (const candidate of REQUEST_CANDIDATES) {
    try {
      raw = await fs.readFile(candidate, 'utf8')
      path = candidate
      break
    } catch (error) {
      if (error && error.code !== 'ENOENT') throw error
    }
  }
  if (raw === undefined || path === undefined) {
    throw new Error(`request file not found in ${REQUEST_CANDIDATES.join(' or ')}`)
  }
  const request = JSON.parse(raw)
  if (typeof request.url !== 'string' || !/^https?:\/\//u.test(request.url)) {
    throw new Error('request.url must be an absolute http(s) URL')
  }
  if (typeof request.output !== 'string' || !isAbsolute(request.output)) {
    throw new Error('request.output must be an absolute path')
  }
  await fs.rm(path, { force: true })
  return request
}

/** Collect the page's title, text, headings, and links. */
function extractPage() {
  const text = document.body ? document.body.innerText : ''
  const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
    .map(node => (node.textContent || '').trim())
    .filter(Boolean)
    .slice(0, 80)
  const seen = new Set()
  const links = []
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = anchor.href
    const label = (anchor.textContent || '').trim()
    if (!href || href.startsWith('javascript:') || seen.has(href)) continue
    seen.add(href)
    links.push({ text: label.slice(0, 120), href })
    if (links.length >= 200) break
  }
  return {
    title: document.title,
    url: location.href,
    text,
    headings,
    links,
  }
}

/** Clamp the caller's excerpt limit to a bounded, positive value. */
function excerptLimit(value) {
  const requested = Number(value)
  if (!Number.isFinite(requested) || requested <= 0) return 200_000
  return Math.min(Math.max(Math.trunc(requested), 1_000), 1_000_000)
}

let space
try {
  const request = await readRequest()
  const limit = excerptLimit(request.maxChars)
  space = await taskSpace(request.space || 'legal-research')
  const page = space.page(request.page || 'p1')

  await page.goto(request.url)
  await page.waitForLoadState('domcontentloaded')
  if (typeof request.waitFor === 'string' && request.waitFor.length > 0) {
    await page.waitForSelector(request.waitFor, { timeout: request.timeout || 20_000 })
  } else {
    await page.waitForTimeout(1_000)
  }
  const extracted = await page.evaluate(extractPage)
  const fullTextPath = `${request.output}.txt`
  const text = extracted.text.slice(0, limit)
  const record = {
    requestedUrl: request.url,
    finalUrl: extracted.url,
    title: extracted.title,
    headings: extracted.headings,
    links: extracted.links,
    text,
    chars: extracted.text.length,
    textChars: text.length,
    truncated: extracted.text.length > text.length,
    fullTextPath,
    fetchedAt: new Date().toISOString(),
  }
  await fs.mkdir(dirname(request.output), { recursive: true })
  await fs.writeFile(fullTextPath, extracted.text, 'utf8')
  await fs.writeFile(
    request.output,
    request.textOnly ? record.text : JSON.stringify(record, null, 2),
    'utf8',
  )
  console.log(JSON.stringify({
    ok: true,
    title: record.title,
    finalUrl: record.finalUrl,
    chars: record.chars,
    textChars: record.textChars,
    truncated: record.truncated,
    output: request.output,
    fullTextPath,
    spaceId: space.spaceId,
  }))
} catch (error) {
  console.log(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    spaceId: space?.spaceId ?? null,
  }))
  process.exitCode = 1
}
