import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { serveStaticAsset } from "../../src/gateway/server/staticAssets.js";

/**
 * staticAssets 单测（docs/workbuddy-sati-performance-analysis-review.md P1-12
 * → 第二批 #9）：单次 stat 判文件 + SPA 回退 + ETag/304 协商。
 */

type MockResponse = Writable & {
  statusCode: number;
  headers: Record<string, string>;
  writeHead(status: number, headers?: Record<string, string>): MockResponse;
};

function makeResponse(): { response: MockResponse; body: () => string; finished: Promise<void> } {
  const chunks: Buffer[] = [];
  let resolveFinished: () => void = () => {};
  const finished = new Promise<void>(resolve => {
    resolveFinished = resolve;
  });
  const response = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  }) as MockResponse;
  response.statusCode = 0;
  response.headers = {};
  response.writeHead = (status: number, headers?: Record<string, string>) => {
    response.statusCode = status;
    response.headers = headers ?? {};
    return response;
  };
  response.on("finish", () => resolveFinished());
  return { response, body: () => Buffer.concat(chunks).toString("utf8"), finished };
}

function makeRequest(ifNoneMatch?: string): IncomingMessage {
  return { headers: ifNoneMatch !== undefined ? { "if-none-match": ifNoneMatch } : {} } as IncomingMessage;
}

/** serveStaticAsset 的测试包装：MockResponse 仅实现用到的 ServerResponse 面。 */
function serve(root: string, path: string, response: MockResponse, request?: IncomingMessage): boolean {
  return serveStaticAsset(root, path, response as unknown as ServerResponse, request);
}

function withStaticRoot(t: test.TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "static-assets-"));
  writeFileSync(join(dir, "index.html"), "<html>index</html>");
  writeFileSync(join(dir, "app.js"), "console.log('app');");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("staticAssets: 命中文件返回 200 + content-type + ETag", async t => {
  const root = withStaticRoot(t);
  const { response, body, finished } = makeResponse();
  const handled = serve(root, "/app.js", response, makeRequest());
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/javascript; charset=utf-8");
  assert.ok(response.headers.etag, "应输出 ETag");
  await finished;
  assert.equal(body(), "console.log('app');");
});

test("staticAssets: SPA 路由回退 index.html（候选不存在时单次 stat 判定）", async t => {
  const root = withStaticRoot(t);
  const { response, body, finished } = makeResponse();
  const handled = serve(root, "/some/client/route", response, makeRequest());
  assert.equal(handled, true);
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  await finished;
  assert.equal(body(), "<html>index</html>");
});

test("staticAssets: 根路径 '/' 映射 index.html", async t => {
  const root = withStaticRoot(t);
  const { response, body, finished } = makeResponse();
  const handled = serve(root, "/", response, makeRequest());
  assert.equal(handled, true);
  await finished;
  assert.equal(body(), "<html>index</html>");
});

test("staticAssets: ETag 匹配返回 304 不读文件体", async t => {
  const root = withStaticRoot(t);
  const first = makeResponse();
  serve(root, "/app.js", first.response, makeRequest());
  await first.finished;
  const etag = first.response.headers.etag!;
  assert.ok(etag);

  const second = makeResponse();
  const handled = serve(root, "/app.js", second.response, makeRequest(etag));
  assert.equal(handled, true);
  assert.equal(second.response.statusCode, 304);
  assert.equal(second.body(), "", "304 不应携带文件体");
});

test("staticAssets: 目录穿越路径归一化后落在 root 内（回退 index.html，不泄漏外部文件）", async t => {
  const root = withStaticRoot(t);
  // normalize("/../etc/passwd") → "/etc/passwd"，join(root, …) 后仍在 root 内：
  // 不泄漏真实 /etc/passwd，而是回退 index.html。
  const { response, body, finished } = makeResponse();
  const handled = serve(root, "/../etc/passwd", response, makeRequest());
  assert.equal(handled, true);
  await finished;
  assert.equal(body(), "<html>index</html>", "穿越路径不得泄漏 root 外文件内容");
});

test("staticAssets: 候选缺失回退 index.html；index.html 也缺失时返回 false", async t => {
  const root = withStaticRoot(t);
  // 候选缺失 → SPA 回退 index.html（返回 true，这是设计行为）
  const r1 = makeResponse();
  assert.equal(serve(root, "/nonexistent-asset", r1.response, makeRequest()), true);
  await r1.finished;

  // index.html 也缺失（root 仅含 app.js）→ 无法回退 → false
  const dir = mkdtempSync(join(tmpdir(), "static-assets-noindex-"));
  writeFileSync(join(dir, "app.js"), "console.log('app');");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r2 = makeResponse();
  assert.equal(serve(dir, "/nope", r2.response, makeRequest()), false);
  const r3 = makeResponse();
  assert.equal(serve(dir, "/app.js", r3.response, makeRequest()), true, "存在文件仍应正常服务");
  await r3.finished;
});

test("staticAssets: 静态根目录缺失返回 false", () => {
  const { response } = makeResponse();
  assert.equal(serve("/nonexistent-root", "/", response, makeRequest()), false);
});
