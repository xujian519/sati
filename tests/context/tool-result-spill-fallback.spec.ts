/**
 * T3d：spill 落盘失败的降级路径必须留痕（降级但不静默）。
 *
 * 失败为**真实 I/O 错误**：toolResultsDir 的父路径被普通文件占据 ⇒ mkdir 以
 * ENOTDIR 失败（非 mock）。断言三件事：
 *   ① 回退原始投影——原文不丢、不替换为引用块（AgentLoop 二重兜底的前提）；
 *   ② 诊断 tool_result_persistence_failed 仍产出（既有契约）；
 *   ③ warn 留痕——此前该诊断全仓零消费，等于事实静默点（issue: 降级但不静默）。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("spill 落盘失败：回退原始投影 + 诊断 + warn 留痕（真实 ENOTDIR）", async t => {
  const dir = await mkdtemp(join(tmpdir(), "sati-spill-fallback-"));
  try {
    // 父路径被普通文件占据：mkdir(dirname(path), { recursive: true }) 以 ENOTDIR 失败。
    const blocker = join(dir, "blocker");
    await writeFile(blocker, "not a directory");
    const budget = new ToolResultBudget({
      toolResultsDir: join(blocker, "tool-results"),
      // 小预算：1000 字符正文必然超限，进入持久化路径。
      maxResultSizeTokens: 16,
    });
    const runtime = new DefaultContextRuntime({ toolResultBudget: budget });
    const mockWarn = t.mock.method(console, "warn", () => undefined);

    const original: CanonicalMessage = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call-spill",
          content: [{ type: "text", text: `search output start\n${"x".repeat(1_000)}\nsearch output tail` }],
        },
      ],
    };
    const result = await runtime.applyToolResults({
      sessionId: "s1",
      turnId: "t1",
      toolResultMessage: original,
      messages: [],
    });

    const [appended] = result.appendedMessages ?? [];
    assert.deepEqual(appended, original, "落盘失败必须回退原始投影（原文不丢、不替换为引用块）");
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.code, "tool_result_persistence_failed");
    assert.equal(result.diagnostics[0]?.severity, "error");
    assert.equal(mockWarn.mock.calls.length, 1, "落盘降级必须留痕（诊断零消费时即为静默）");
    assert.match(
      String(mockWarn.mock.calls[0]!.arguments[0]),
      /Failed to persist tool result; keeping original projection/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
