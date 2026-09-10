import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";

/**
 * 上游 #569：系统提示的日期在运行时构造后冻结。
 *
 * `<environment>now: YYYY-MM-DD</environment>` 落在 system prompt 前缀里，是
 * Anthropic prompt cache 的缓存键的一部分。若每次组装都取实时时钟，跨午夜后
 * 前缀变化会让整段缓存失效——长会话跑过零点要为此重付一次全量 prefill。
 * 需要实时时间的工作走 get_current_time 工具，与提示前缀无关。
 */
function makeInput(): ContextPrepareInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    provider: "test",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
    tools: [],
  };
}

describe("DefaultContextRuntime 系统提示日期冻结", () => {
  it("跨午夜后 systemPrompt 逐字不变", async () => {
    let current = new Date("2026-09-10T23:59:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const before = await runtime.prepareForModel(makeInput());

    current = new Date("2026-09-11T00:01:00.000Z");
    const after = await runtime.prepareForModel(makeInput());

    assert.match(before.systemPrompt ?? "", /now: 2026-09-10/);
    assert.equal(after.systemPrompt, before.systemPrompt);
  });

  it("提示日期取构造时刻，而非首次组装时刻", async () => {
    const runtime = new DefaultContextRuntime({ now: () => new Date("2026-01-02T12:00:00.000Z") });
    const context = await runtime.prepareForModel(makeInput());
    assert.match(context.systemPrompt ?? "", /now: 2026-01-02/);
  });

  it("不同运行时各自冻结自己的日期（不是进程级常量）", async () => {
    const first = new DefaultContextRuntime({ now: () => new Date("2026-03-04T00:00:00.000Z") });
    const second = new DefaultContextRuntime({ now: () => new Date("2026-03-05T00:00:00.000Z") });

    assert.match((await first.prepareForModel(makeInput())).systemPrompt ?? "", /now: 2026-03-04/);
    assert.match((await second.prepareForModel(makeInput())).systemPrompt ?? "", /now: 2026-03-05/);
  });
});
