import test from "node:test";
import assert from "node:assert/strict";
import {
  __setWebFetchHookForTesting,
  clearWebFetchCache,
  createWebFetchTool,
  isPermittedRedirect,
  isPreapprovedHost,
  isPreapprovedUrl,
  MAX_MARKDOWN_LENGTH,
  MAX_REDIRECTS,
  MAX_URL_LENGTH,
  truncateMarkdown,
  type FetchHook,
  upgradeHttpToHttps,
  validateURL,
  WEB_FETCH_USER_AGENT,
} from "../../src/tool/index.js";

const baseHeaders = (extra: Record<string, string> = {}) => ({
  "content-type": "text/html",
  ...extra,
});

function makeFetchHook(
  responses: Array<{
    status: number;
    statusText?: string;
    headers?: Record<string, string>;
    body: string | Buffer;
  }>,
): FetchHook & { calls: Array<{ url: string; headers: Record<string, string> }> } {
  let i = 0;
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const hook: FetchHook = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (!r) throw new Error("no response queued");
    const buf = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
    const ab = new ArrayBuffer(buf.byteLength);
    new Uint8Array(ab).set(buf);
    return {
      status: r.status,
      statusText: r.statusText ?? "",
      headers: r.headers ?? {},
      arrayBuffer: async () => ab,
    };
  };
  Object.assign(hook, { calls });
  return hook as FetchHook & { calls: typeof calls };
}

test("B2.W1 MAX_URL_LENGTH parity (=2000)", () => {
  assert.equal(MAX_URL_LENGTH, 2000);
});

test("B2.W2 validateURL rejects oversized / malformed / credentialed / single-label hosts", () => {
  assert.equal(validateURL("https://example.com"), true);
  assert.equal(validateURL("https://docs.example.com/x"), true);
  assert.equal(validateURL("https://" + "a".repeat(MAX_URL_LENGTH)), false);
  assert.equal(validateURL("not a url"), false);
  assert.equal(validateURL("https://user:pass@example.com"), false);
  assert.equal(validateURL("https://localhost"), false);
  assert.equal(validateURL("https://intranet"), false);
});

test("B2.W3 upgradeHttpToHttps upgrades http only", () => {
  assert.equal(upgradeHttpToHttps("http://example.com/p").upgraded, "https://example.com/p");
  assert.equal(upgradeHttpToHttps("https://example.com/p").upgraded, "https://example.com/p");
});

test("B2.W6 MAX_REDIRECTS parity (=10)", () => {
  assert.equal(MAX_REDIRECTS, 10);
});

test("B2.W7 isPermittedRedirect honours protocol/port/credentials and ±www host", () => {
  assert.equal(isPermittedRedirect("https://a.com", "https://www.a.com/x"), true);
  assert.equal(isPermittedRedirect("https://www.a.com", "https://a.com/x"), true);
  assert.equal(isPermittedRedirect("https://a.com", "https://a.com/y"), true);
  assert.equal(isPermittedRedirect("https://a.com", "https://b.com"), false);
  assert.equal(isPermittedRedirect("https://a.com", "http://a.com"), false);
  assert.equal(isPermittedRedirect("https://a.com", "https://a.com:8080"), false);
  assert.equal(isPermittedRedirect("https://a.com", "https://u:p@a.com"), false);
});

test("B2.W12 truncateMarkdown caps at MAX_MARKDOWN_LENGTH and appends sentinel", () => {
  const long = "x".repeat(MAX_MARKDOWN_LENGTH + 100);
  const truncated = truncateMarkdown(long);
  assert.ok(truncated.length <= MAX_MARKDOWN_LENGTH + 100);
  assert.match(truncated, /Content truncated due to length/);
  assert.equal(truncateMarkdown("short"), "short");
});

test("B2.W14 isPreapprovedHost spot-checks (positive + negative)", () => {
  assert.equal(isPreapprovedHost("docs.anthropic.com", "/"), true);
  assert.equal(isPreapprovedHost("github.com", "/foo"), true);
  assert.equal(isPreapprovedHost("en.wikipedia.org", "/x"), true, "subdomain via allowSubdomains");
  assert.equal(isPreapprovedHost("vercel.com", "/docs/anything"), true, "path prefix match");
  assert.equal(isPreapprovedHost("vercel.com", "/blog/x"), false, "path prefix mismatch");
  assert.equal(isPreapprovedHost("evil.example.com", "/"), false);
  assert.equal(isPreapprovedHost("api.notion.so", "/help/x"), false, "no subdomain & path mismatch");
  assert.equal(isPreapprovedUrl("https://docs.anthropic.com/api"), true);
  assert.equal(isPreapprovedUrl("not a url"), false);
});

test("B2.E_TOOL web_fetch tool definition shape", () => {
  const def = createWebFetchTool();
  assert.equal(def.name, "web_fetch");
  assert.deepEqual(def.aliases, ["WebFetch"]);
  assert.equal(def.kind, "network");
  assert.equal(def.isReadOnly({ url: "x", prompt: "x" }), true);
  assert.equal(def.isConcurrencySafe({ url: "x", prompt: "x" }), true);
  assert.equal(def.isOpenWorld?.({ url: "x", prompt: "x" }), true);
  assert.equal(def.maxResultBytes, 200_000);
  assert.match(def.description, /can process it using a secondary AI model/);
  assert.match(def.description, /Without a model client, returns the fetched markdown content directly/);
  assert.equal(
    def.inputSchema.properties?.url?.description,
    "Fully-formed URL to fetch. HTTP URLs will be upgraded to HTTPS before the request is issued.",
  );
  assert.equal(
    def.inputSchema.properties?.prompt?.description,
    "Question or extraction directive to apply to the fetched markdown. When no model client is available, the tool returns raw markdown instead of a prompted summary.",
  );
});

test("B2.E_VALIDATE rejects bad inputs", async () => {
  const def = createWebFetchTool();
  const v1 = await def.validateInput?.(
    { url: "", prompt: "x" } as never,
    {} as never,
  );
  assert.equal(v1?.ok, false);
  const v2 = await def.validateInput?.(
    { url: "https://user:pass@example.com", prompt: "x" } as never,
    {} as never,
  );
  assert.equal(v2?.ok, false);
  const v3 = await def.validateInput?.(
    { url: "https://example.com", prompt: "" } as never,
    {} as never,
  );
  assert.equal(v3?.ok, false);
  const v4 = await def.validateInput?.(
    { url: "https://example.com", prompt: "what" } as never,
    {} as never,
  );
  assert.equal(v4?.ok, true);
});

test("B2.E_FETCH happy-path (HTML→markdown, sets User-Agent, no model → returns truncated markdown)", async () => {
  clearWebFetchCache();
  const html = "<html><body><h1>Hello</h1><p>world</p></body></html>";
  const hook = makeFetchHook([{ status: 200, statusText: "OK", headers: baseHeaders(), body: html }]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const result = await def.execute(
      { url: "https://example.com/page", prompt: "summarize" },
      {
        sessionId: "s",
        turnId: "t",
        cwd: process.cwd(),
        permissionMode: "default",
        permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
      } as never,
    );
    assert.equal(hook.calls.length, 1);
    assert.equal(hook.calls[0]!.url, "https://example.com/page");
    assert.equal(hook.calls[0]!.headers["User-Agent"], WEB_FETCH_USER_AGENT);
    assert.equal(result.data?.bytes, Buffer.byteLength(html));
    assert.equal(result.data?.status, 200);
    assert.equal(result.data?.fromCache, false);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /Hello/);
    assert.match(text, /world/);
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_HTTPS upgrades http→https before issuing the request", async () => {
  clearWebFetchCache();
  const hook = makeFetchHook([
    { status: 200, statusText: "OK", headers: baseHeaders(), body: "<p>ok</p>" },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    await def.execute(
      { url: "http://example.com/p", prompt: "x" },
      {
        sessionId: "s",
        turnId: "t",
        cwd: process.cwd(),
        permissionMode: "default",
        permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
      } as never,
    );
    assert.equal(hook.calls[0]!.url, "https://example.com/p");
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_REDIRECT cross-host redirect surfaced (not auto-followed)", async () => {
  clearWebFetchCache();
  const hook = makeFetchHook([
    {
      status: 302,
      statusText: "Found",
      headers: { location: "https://evil.example/here" },
      body: "",
    },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const result = await def.execute(
      { url: "https://example.com/p", prompt: "x" },
      {
        sessionId: "s",
        turnId: "t",
        cwd: process.cwd(),
        permissionMode: "default",
        permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
      } as never,
    );
    assert.equal(result.data?.redirect?.statusCode, 302);
    assert.equal(result.data?.redirect?.redirectUrl, "https://evil.example/here");
    const text = (result.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /Redirect detected/);
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_REDIRECT permitted same-host redirect followed up to MAX_REDIRECTS", async () => {
  clearWebFetchCache();
  const hook = makeFetchHook([
    { status: 302, headers: { location: "https://www.example.com/p" }, body: "" },
    { status: 200, headers: baseHeaders(), body: "<p>ok</p>" },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const result = await def.execute(
      { url: "https://example.com/p", prompt: "x" },
      {
        sessionId: "s",
        turnId: "t",
        cwd: process.cwd(),
        permissionMode: "default",
        permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
      } as never,
    );
    assert.equal(hook.calls.length, 2);
    assert.equal(hook.calls[1]!.url, "https://www.example.com/p");
    assert.equal(result.data?.status, 200);
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_CACHE second call within TTL returns fromCache=true and does not re-hit network", async () => {
  clearWebFetchCache();
  const hook = makeFetchHook([
    { status: 200, headers: baseHeaders(), body: "<p>v1</p>" },
    { status: 200, headers: baseHeaders(), body: "<p>v2</p>" },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const ctx = {
      sessionId: "s",
      turnId: "t",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
    } as never;
    const r1 = await def.execute({ url: "https://example.com/p", prompt: "x" }, ctx);
    const r2 = await def.execute({ url: "https://example.com/p", prompt: "x" }, ctx);
    assert.equal(hook.calls.length, 1, "second call served from cache");
    assert.equal(r1.data?.fromCache, false);
    assert.equal(r2.data?.fromCache, true);
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_BINARY non-text content returns sentinel marker", async () => {
  clearWebFetchCache();
  const buf = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  const hook = makeFetchHook([
    { status: 200, headers: { "content-type": "image/jpeg" }, body: buf },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const ctx = {
      sessionId: "s",
      turnId: "t",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
    } as never;
    const r = await def.execute({ url: "https://example.com/img.jpg", prompt: "x" }, ctx);
    const text = (r.content[0] as { type: "text"; text: string }).text;
    assert.match(text, /Binary image\/jpeg content/);
  } finally {
    __setWebFetchHookForTesting(null);
  }
});

test("B2.E_SECONDARY_MODEL invokes context.model and returns its response", async () => {
  clearWebFetchCache();
  const hook = makeFetchHook([
    { status: 200, headers: baseHeaders(), body: "<h1>Title</h1>" },
  ]);
  __setWebFetchHookForTesting(hook);
  try {
    const def = createWebFetchTool();
    const ctx = {
      sessionId: "s",
      turnId: "t",
      cwd: process.cwd(),
      permissionMode: "default",
      permissionContext: { cwd: process.cwd(), mode: "default", canPrompt: false } as never,
      model: {
        async *stream() {
          yield { type: "text_delta", text: "summary " } as never;
          yield { type: "text_delta", text: "answer" } as never;
        },
      },
    } as never;
    const r = await def.execute({ url: "https://example.com/p", prompt: "summarize" }, ctx);
    const text = (r.content[0] as { type: "text"; text: string }).text;
    assert.equal(text, "summary answer");
    assert.equal(r.data?.modelResponse, "summary answer");
  } finally {
    __setWebFetchHookForTesting(null);
  }
});
