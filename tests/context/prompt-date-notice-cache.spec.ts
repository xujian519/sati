import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CachedMicroCompactionEngine } from "../../src/context/compaction/CachedMicroCompactionEngine.js";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import { isPromptDateNotice } from "../../src/context/prompt/promptDateNotice.js";
import type { ContextPrepareInput, ModelContext } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

/**
 * 跨日日期通知插入后，微压缩断点必须仍指向同一批消息。
 *
 * 通知插在列表中间（前一天跨日时落在当时的末尾，后来又被新消息延长）会让整个
 * 消息数组右移；若断点仍按「未插入通知的投影」计算，`cache_control` 就会打到
 * 错误的块上（甚至打到通知自己），缓存前缀随之错位。因此断点必须在最终请求消息
 * 数组上计算。
 */

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

/** 一轮可微压缩工具调用：read_file 属于 COMPACTABLE_TOOL_NAMES。 */
function readTurn(index: number): CanonicalMessage[] {
  return [
    {
      role: "assistant",
      content: [{ type: "tool_call", id: `read-${index}`, name: "read_file", input: { path: `f${index}.ts` } }],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: `read-${index}`,
          content: [{ type: "text", text: "source code line\n".repeat(50) }],
        },
      ],
    },
  ];
}

function makeInput(overrides: Partial<ContextPrepareInput> = {}): ContextPrepareInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    provider: "anthropic",
    model: "claude-x",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    messages: [userMessage("inspect these files")],
    tools: [],
    ...overrides,
  };
}

/**
 * 断点语义（M6）：标记「被老化 tool_result 的前一条消息」。因此每个断点下标 i 的
 * 下一条消息必须是一条可微压缩工具结果；下标错位时该性质必然被破坏。
 */
function assertBreakpointsAlignWithAgedToolResults(context: ModelContext): void {
  const breakpoints = context.cacheBreakpoints ?? [];
  assert.ok(breakpoints.length > 0, "本用例应产生微压缩断点");
  for (const index of breakpoints) {
    const next = context.messages[index + 1];
    assert.ok(next !== undefined && next.role === "user", `断点 ${index} 的下一条应为工具结果消息`);
    assert.ok(
      next.content.some(block => block.type === "tool_result"),
      `断点 ${index} 的下一条应为 tool_result`,
    );
    assert.equal(isPromptDateNotice(context.messages[index]!), false, `断点 ${index} 不应打在日期通知上`);
  }
}

describe("跨日通知与微压缩断点同源", () => {
  it("插入位于列表中间的日期通知后，断点仍指向被老化工具结果的前一条消息", async () => {
    let current = new Date("2026-09-10T09:00:00.000Z");
    const runtime = new DefaultContextRuntime({
      now: () => current,
      microcompactEngine: new CachedMicroCompactionEngine({ enabled: true }),
    });
    const messages = [userMessage("inspect these files"), ...[0, 1, 2, 3, 4, 5].flatMap(readTurn)];

    const day1 = await runtime.prepareForModel(makeInput({ messages }));
    assert.equal(day1.messages.some(isPromptDateNotice), false);
    assert.deepEqual(day1.cacheBreakpoints, [1, 3]);
    assertBreakpointsAlignWithAgedToolResults(day1);

    // 跨日：当日投影是一轮完整工具调用（下标 0..2），通知因此落在下标 3。
    current = new Date("2026-09-11T09:00:00.000Z");
    const rollover = await runtime.prepareForModel(makeInput({ messages: messages.slice(0, 3) }));
    assert.equal(isPromptDateNotice(rollover.messages[3]!), true);

    // 同日携带完整历史：通知停在下标 3，其后消息整体右移一位。
    const day2 = await runtime.prepareForModel(makeInput({ messages }));
    assert.equal(isPromptDateNotice(day2.messages[3]!), true);
    assert.deepEqual(day2.cacheBreakpoints, [1, 4]);
    assertBreakpointsAlignWithAgedToolResults(day2);
  });
});
