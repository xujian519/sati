/**
 * 记忆检索非阻塞注入（#536）：`prepareForModel` 不再为慢检索阻塞首 token。
 *
 * 契约：
 *  - 预算内返回（缓存命中 / 同步 FTS·DB / 快响应）→ 本轮照常注入，单轮问答不退化；
 *  - 超预算 → 本轮空注入 + `memory_retrieval_deferred` info 诊断，且**不中止**内层检索，
 *    让其在后台跑完写入 provider TTL 缓存，下一轮同 query 命中（「到期即有则注入、超时降级
 *    为空 + 后台预热」）。预算到期只「停止等待」；真正取消仅来自硬熔断或回合级 abortSignal。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { MemoryResolver, MemoryRetrieveResult } from "../../src/context/memory/MemoryResolver.js";
import type { ContextPrepareInput } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function makeInput(): ContextPrepareInput {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    provider: "anthropic",
    model: "claude-x",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    messages: [userMessage("这个结构的强度和重量存在矛盾")],
    tools: [],
  };
}

test("快检索在预算内 → 本轮照常注入（单轮问答不退化为下一轮）", async () => {
  const resolver = {
    retrieve: async () => ({ systemContext: "即时记忆", diagnostics: [] }),
    captureTurn: async () => {},
  } as unknown as MemoryResolver;
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, memoryInjectionBudgetMs: 2000 });

  const context = await runtime.prepareForModel(makeInput());

  assert.deepEqual(context.tailInjections, [
    { source: "memory", text: "<memory-context>\n即时记忆\n</memory-context>" },
  ]);
  assert.equal(
    context.diagnostics.some(d => d.code === "memory_retrieval_deferred"),
    false,
    "预算内命中不应记 deferred",
  );
});

test("慢检索超预算 → 本轮空注入 + deferred 诊断，且不中止内层（保留后台预热）", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let capturedSignal: AbortSignal | undefined;
  const resolver = {
    retrieve: (input: { signal?: AbortSignal }) => {
      capturedSignal = input.signal;
      return new Promise<MemoryRetrieveResult>(() => {}); // 永不结算：模拟内层卡住
    },
    captureTurn: async () => {},
  } as unknown as MemoryResolver;
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, memoryInjectionBudgetMs: 2000 });

  const pending = runtime.prepareForModel(makeInput());
  // 负控制锚点：若把预算到期改成「继续等满硬熔断」，tick(2000) 后 prepareForModel 不会返回，
  // 本用例会挂起失败；若预算到期误 abort 内层，下面的 capturedSignal.aborted 断言会红。
  t.mock.timers.tick(2000);
  const context = await pending;

  assert.equal(context.tailInjections?.length ?? 0, 0, "超预算本轮不注入");
  assert.ok(
    context.diagnostics.some(d => d.code === "memory_retrieval_deferred"),
    "应记 memory_retrieval_deferred（可观测，不静默）",
  );
  assert.equal(capturedSignal?.aborted, false, "预算到期只停止等待，不得 abort 内层检索");
});

test("预算 <= 0 关闭非阻塞：退化为完整等待（旧行为，慢检索也会本轮注入）", async () => {
  let resolveRetrieve: (() => void) | undefined;
  const resolver = {
    retrieve: () =>
      new Promise<MemoryRetrieveResult>(resolve => {
        resolveRetrieve = () => resolve({ systemContext: "迟到的记忆", diagnostics: [] });
      }),
    captureTurn: async () => {},
  } as unknown as MemoryResolver;
  const runtime = new DefaultContextRuntime({ memoryResolver: resolver, memoryInjectionBudgetMs: 0 });

  const pending = runtime.prepareForModel(makeInput());
  // 预算关闭 ⇒ prepareForModel 一直等到检索结算（让出一个 macrotask 后再 resolve）。
  await new Promise(resolve => setImmediate(resolve));
  resolveRetrieve?.();
  const context = await pending;

  assert.deepEqual(context.tailInjections, [
    { source: "memory", text: "<memory-context>\n迟到的记忆\n</memory-context>" },
  ]);
  assert.equal(
    context.diagnostics.some(d => d.code === "memory_retrieval_deferred"),
    false,
    "完整等待路径不记 deferred",
  );
});
