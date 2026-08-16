import assert from "node:assert/strict";
import test from "node:test";
import { isSessionExpired, withTimeout, McpClientError } from "../../../src/mcp/client/errors.js";

test("isSessionExpired: statusCode 404 判为过期", () => {
  assert.equal(isSessionExpired({ statusCode: 404, message: "session not found" }), true);
});

test("isSessionExpired: message 含 session expired（大小写不敏感）判为过期", () => {
  assert.equal(isSessionExpired({ message: "Session Expired" }), true);
});

test("isSessionExpired: 无关错误 / null 不判为过期", () => {
  assert.equal(isSessionExpired({ statusCode: 500, message: "boom" }), false);
  assert.equal(isSessionExpired(null), false);
  assert.equal(isSessionExpired("string error"), false);
});

test("withTimeout: 正常 resolve 清除定时器", async () => {
  const result = await withTimeout(Promise.resolve("ok"), 1_000, () => new Error("timeout"));
  assert.equal(result, "ok");
});

test("withTimeout: 超时用 errorFactory 错误拒绝", async () => {
  await assert.rejects(
    withTimeout(new Promise(() => {}), 10, () => new McpClientError("handshake timed out", "mcp_handshake_failed")),
    /handshake timed out/,
  );
});
