import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildTransport, DEFAULT_CALL_TIMEOUT_MS } from "../../../src/mcp/client/transport.js";
import type { SatiMcpServerSpec } from "../../../src/mcp/protocol/types.js";
import { McpClientError } from "../../../src/mcp/client/errors.js";

test("buildTransport: stdio perSession 创建临时目录并注入 --user-data-dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-transport-test-"));
  try {
    const spec = {
      id: "t1",
      transport: "stdio" as const,
      command: "node",
      args: ["serve.js"],
      perSession: true,
    };
    const built = buildTransport(spec, {});
    assert.ok(built.perSessionDir !== null, "perSession 应创建临时目录");
    assert.ok(built.perSessionDir.startsWith(join(tmpdir(), "sati-mcp-t1-")));
    const stdio = built.transport as unknown as { _serverParams?: { args?: string[] } };
    assert.ok(
      stdio._serverParams?.args?.some(a => a.startsWith("--user-data-dir=")),
      "args 应注入 user-data-dir",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildTransport: stdio 非 perSession 不建临时目录", () => {
  const built = buildTransport(
    { id: "t2", transport: "stdio", command: "node", args: ["serve.js"], perSession: false },
    {},
  );
  assert.equal(built.perSessionDir, null);
});

test("buildTransport: 未知 transport 抛 mcp_unsupported_transport", () => {
  assert.throws(
    () =>
      buildTransport(
        // 故意构造非法 transport 的 spec（错误路径测试）
        { id: "t3", transport: "sse", url: "https://x.test/sse" } as unknown as SatiMcpServerSpec,
        {},
      ),
    (err: unknown) => err instanceof McpClientError && err.code === "mcp_unsupported_transport",
  );
});

test("DEFAULT_CALL_TIMEOUT_MS: 模块加载期解析为正数", () => {
  assert.ok(Number.isFinite(DEFAULT_CALL_TIMEOUT_MS) && DEFAULT_CALL_TIMEOUT_MS > 0);
});
