/**
 * web_fetch 错误路径负向演练（计划 T4：此前无独立 spec）。
 *
 * 覆盖两类结构化错误：
 *   1. HTTP 错（瞬时 503 + Retry-After / 非瞬时 404）——错误消息必须携带
 *      「不要把错误页当页面内容」的模型侧指导（防止拿错误页当正文分析）；
 *   2. EGRESS_BLOCKED——走**真实** urlFetcher 路径（allowlist 代理拦截），
 *      不是 mock 抛出。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createWebFetchTool } from "../../../src/tool/builtin/webFetch.js";
import { WebFetchHttpError, __setWebFetchHookForTesting } from "../../../src/tool/builtin/web/urlFetcher.js";
import type { SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";

/** 测试上下文：仅提供 execute 用到的最小字段集。 */
function testContext(): SatiToolRuntimeContext {
  return { env: {}, cwd: "/", projectRoot: "/", abortSignal: undefined } as unknown as SatiToolRuntimeContext;
}

test("HTTP 瞬时错误（503 + Retry-After）：结构化错误含「不要当页面内容」与重试提示", async () => {
  const tool = createWebFetchTool({
    fetchUrl: async () => {
      throw new WebFetchHttpError({
        url: "https://example.test/temp",
        status: 503,
        statusText: "Service Unavailable",
        retryAfterMs: 5_000,
        contentType: "text/html",
      });
    },
  });

  await assert.rejects(
    tool.execute({ url: "https://example.test/temp", mode: "raw" }, testContext()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal((error as { code?: string }).code, "tool_execution_failed");
      assert.match(error.message, /do not treat the error page as page content/);
      assert.match(error.message, /Retry-After: 5000ms/);
      return true;
    },
  );
});

test("HTTP 非瞬时错误（404）：给出「页面不可用」指导而非空结果", async () => {
  const tool = createWebFetchTool({
    fetchUrl: async () => {
      throw new WebFetchHttpError({
        url: "https://example.test/missing",
        status: 404,
        statusText: "Not Found",
      });
    },
  });

  await assert.rejects(
    tool.execute({ url: "https://example.test/missing", mode: "raw" }, testContext()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /did not return a usable page/);
      assert.doesNotMatch(error.message, /Retry-After/);
      return true;
    },
  );
});

test("EGRESS_BLOCKED：走真实 urlFetcher 路径（allowlist 代理拦截）", async t => {
  // 真实路径：hook 模拟代理返回 403 + blocked-by-allowlist ⇒ urlFetcher 抛 EGRESS_BLOCKED。
  __setWebFetchHookForTesting(async () => ({
    status: 403,
    statusText: "Forbidden",
    headers: { "x-proxy-error": "blocked-by-allowlist" },
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  t.after(() => __setWebFetchHookForTesting(null));

  const tool = createWebFetchTool();
  await assert.rejects(
    tool.execute({ url: "https://blocked.example.test/x", mode: "raw" }, testContext()),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /EGRESS_BLOCKED/);
      assert.match(error.message, /blocked by the network egress proxy/);
      return true;
    },
  );
});
