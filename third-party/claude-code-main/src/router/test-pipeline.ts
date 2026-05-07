#!/usr/bin/env bun
/**
 * Quick test: CCR pipeline fetch interceptor (zero-port mode).
 */
import { createServer } from "http";
import { resolve, dirname } from "path";

const DIR = dirname(new URL(import.meta.url).pathname);
const CCR = require(resolve(DIR, "server.cjs"));
const Server = CCR.default;

let passed = 0;
let failed = 0;
function assert(ok: boolean, name: string) {
  if (ok) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

// Start mock provider
const mockServer = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const parsed = JSON.parse(body || "{}");
    const isStream = parsed.stream === true;
    if (!isStream) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: "chatcmpl-test",
        object: "chat.completion",
        model: parsed.model || "test",
        choices: [{ index: 0, message: { role: "assistant", content: "Pipeline zero-port!" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
      }));
    } else {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "s1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "Stream" }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "s2", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: " ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 0 } } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    }
  });
});
await new Promise<void>((r) => mockServer.listen(19077, "127.0.0.1", () => r()));

console.log("\n══ Pipeline Zero-Port Test ══\n");

const server = new Server({
  initialConfig: {
    providers: [{ name: "mock", api_base_url: "http://127.0.0.1:19077/v1/chat/completions", api_key: "k", models: ["test-model"], transformer: { use: ["openrouter"] } }],
    Router: { default: "mock,test-model" },
    tokenStats: { enabled: true },
    HOST: "127.0.0.1", PORT: 0, LOG: false,
  },
  logger: false,
});
await server.init();

const SENTINEL = "http://ccr.pipeline.test";
CCR.installFetchInterceptor(SENTINEL, {
  configService: server.configService,
  providerService: server.providerService,
  transformerService: server.transformerService,
  tokenizerService: server.tokenizerService,
  logger: { info() {}, warn() {}, error(...a: any[]) { console.error(...a); }, debug() {} },
});

// Test 1: Health
{
  const res = await fetch(`${SENTINEL}/health`);
  const body = await res.json() as any;
  assert(res.status === 200 && body.status === "ok", "Health check via pipeline");
}

// Test 2: Stats summary
{
  const res = await fetch(`${SENTINEL}/api/stats/summary`);
  const body = await res.json() as any;
  assert(res.status === 200 && body.lifetime !== undefined, "Stats summary via pipeline");
}

// Test 3: Non-streaming /v1/messages
{
  const res = await fetch(`${SENTINEL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock,test-model",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
  const body = await res.json() as any;
  assert(res.status === 200, "/v1/messages non-stream → 200");
  assert(body.type === "message", "response type = message (Anthropic format)");
  assert(body.content?.[0]?.text === "Pipeline zero-port!", "correct content from mock");
}

// Test 4: Streaming /v1/messages
{
  const res = await fetch(`${SENTINEL}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "mock,test-model",
      messages: [{ role: "user", content: "stream test" }],
      stream: true,
    }),
  });
  assert(res.status === 200, "/v1/messages stream → 200");
  assert(res.headers.get("content-type")?.includes("text/event-stream") === true, "streaming content-type");
  const text = await res.text();
  assert(text.includes("data:"), "stream has SSE data events");
}

// Test 5: Non-intercepted fetch still works
{
  const res = await fetch("http://127.0.0.1:19077/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "direct", messages: [] }),
  });
  const body = await res.json() as any;
  assert(body.choices?.[0]?.message?.content === "Pipeline zero-port!", "Non-intercepted fetch passthrough works");
}

// Test 6: No port was opened by CCR
{
  let portFree = true;
  try {
    const check = await fetch("http://127.0.0.1:19080/health");
    if (check.status === 200) {
      const body = await check.json() as any;
      portFree = body.status !== "ok";
    }
  } catch { /* connection refused = port free */ }
  assert(portFree, "Port 19080 has no CCR server (zero-port confirmed)");
}

mockServer.close();

console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
