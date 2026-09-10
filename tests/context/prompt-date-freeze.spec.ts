import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";

/**
 * 系统提示的日期按 UTC 自然日冻结。
 *
 * `<environment>now: YYYY-MM-DD</environment>` 落在 system prompt 前缀里，是
 * Anthropic prompt cache 的缓存键的一部分。若每次组装都取实时时钟，同一会话内
 * 前缀变化会让整段缓存失效——长会话要为此重付一次全量 prefill。
 *
 * 但完全冻结（构造时定死）会让跨午夜仍活跃的会话此后每回合都发旧日期、陈旧没有
 * 上界，故按自然日刷新：同一天内逐字不变（cache 命中），跨天刷新一次，陈旧上界
 * 为 1 天。需要精确到分秒的工作走 get_current_time 工具，与提示前缀无关。
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

describe("DefaultContextRuntime 系统提示日期刷新", () => {
  it("同一自然日内多次组装，systemPrompt 逐字不变", async () => {
    let current = new Date("2026-09-10T00:10:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const morning = await runtime.prepareForModel(makeInput());

    current = new Date("2026-09-10T18:00:00.000Z");
    const evening = await runtime.prepareForModel(makeInput());

    assert.match(morning.systemPrompt ?? "", /now: 2026-09-10/);
    assert.equal(evening.systemPrompt, morning.systemPrompt);
  });

  it("跨自然日刷新一次，其后当日内重新稳定", async () => {
    let current = new Date("2026-09-10T23:50:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    const before = await runtime.prepareForModel(makeInput());
    assert.match(before.systemPrompt ?? "", /now: 2026-09-10/);

    current = new Date("2026-09-11T00:05:00.000Z");
    const afterMidnight = await runtime.prepareForModel(makeInput());

    assert.match(afterMidnight.systemPrompt ?? "", /now: 2026-09-11/);
    assert.notEqual(afterMidnight.systemPrompt, before.systemPrompt);

    current = new Date("2026-09-11T20:00:00.000Z");
    const laterSameDay = await runtime.prepareForModel(makeInput());

    assert.equal(laterSameDay.systemPrompt, afterMidnight.systemPrompt);
  });

  it("首次组装晚于构造时刻时，用的是组装当天的日期", async () => {
    let current = new Date("2026-09-10T12:00:00.000Z");
    const runtime = new DefaultContextRuntime({ now: () => current });

    current = new Date("2026-09-12T09:00:00.000Z");
    const context = await runtime.prepareForModel(makeInput());

    assert.match(context.systemPrompt ?? "", /now: 2026-09-12/);
  });

  it("不同运行时各自维护自己的日期（不是进程级常量）", async () => {
    const first = new DefaultContextRuntime({ now: () => new Date("2026-03-04T00:00:00.000Z") });
    const second = new DefaultContextRuntime({ now: () => new Date("2026-03-05T00:00:00.000Z") });

    assert.match((await first.prepareForModel(makeInput())).systemPrompt ?? "", /now: 2026-03-04/);
    assert.match((await second.prepareForModel(makeInput())).systemPrompt ?? "", /now: 2026-03-05/);
  });
});
