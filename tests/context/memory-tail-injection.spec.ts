/**
 * 记忆附件段的落点：运行时把它交出去作为**尾部注入**，不进 system prompt
 * （2.3「系统提示分桶」）。
 *
 * 记忆附件按检索 query 逐轮变化（`MemoryAttachmentBuilder` 的 query 取自最近用户文本），
 * 而 system prompt 整体是一个缓存前缀块——附件落在里面，被作废的是它**之前**的整段前缀
 * （工具 schema + 整个 system prompt）。压缩后的重注入路径
 * （`CompactionEngine.buildPostCompactMessages`）本来就把它当消息追加，本用例把两条路径
 * 的形态对齐钉住。请求侧的合成消息由调用方拼装（见 `modelRequest.spec.ts` 与
 * `tests/cli/prompt-tail-injection.spec.ts`）。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { DefaultContextRuntime } from "../../src/context/DefaultContextRuntime.js";
import type { MemoryResolver } from "../../src/context/memory/MemoryResolver.js";
import type { ContextPrepareInput, ModelContext } from "../../src/context/protocol/types.js";
import type { CanonicalMessage } from "../../src/model/index.js";

function userMessage(text: string): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function memoryResolver(systemContext: string): MemoryResolver {
  return {
    retrieve: async () => ({ systemContext, diagnostics: [] }),
    captureTurn: async () => {},
  } as unknown as MemoryResolver;
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

async function prepareWith(memory: string): Promise<ModelContext> {
  const runtime = new DefaultContextRuntime({ memoryResolver: memoryResolver(memory) });
  return await runtime.prepareForModel(makeInput());
}

test("记忆附件作为尾部注入交出去：不进 system prompt、原文进注入审计", async () => {
  const context = await prepareWith("这条记忆只在附件里");
  const expected = "<memory-context>\n这条记忆只在附件里\n</memory-context>";

  assert.equal(context.systemPrompt?.includes("这条记忆只在附件里"), false, "记忆附件不得进 system prompt");
  assert.deepEqual(context.tailInjections, [{ source: "memory", text: expected }]);
  // 「模型可见 = 已记录」：附件原文同时进审计清单（落 transcript 的 injected_context）。
  assert.deepEqual(context.injections, context.tailInjections);
});

test("记忆内容逐轮变化时 system prompt 逐字节不变（缓存前缀稳定）", async () => {
  const first = await prepareWith("第一轮的记忆");
  const second = await prepareWith("第二轮完全不同的记忆内容，长一些，确保 token 数不同");

  assert.equal(first.systemPrompt, second.systemPrompt, "system prompt 不得随记忆内容变化");
  assert.notEqual(first.tailInjections?.[0]?.text, second.tailInjections?.[0]?.text);
});

test("无记忆附件时不产生尾部注入（请求形状不变）", async () => {
  const context = await prepareWith("");

  assert.equal(context.tailInjections?.length, 0);
  assert.equal(context.injections?.length, 0);
});
