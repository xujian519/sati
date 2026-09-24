/**
 * `cloneMessage` / `cloneContentBlock`（src/model/protocol/clone.ts）语义钉住。
 *
 * 背景（#535 / TD-WEB-N01）：`readSessionMessages.ts` 的历史重建热路径曾用局部
 * `JSON.parse(JSON.stringify(...))` 深拷贝每条 CanonicalMessage——它丢弃 `undefined`
 * 值字段、对 BigInt/循环引用抛错，并带一次全量序列化开销。修复删除了局部实现，
 * 改用本模块的结构化克隆。本测试直接钉住该共享工具的关键语义，作为回归防线：
 *
 *  1. **非共享引用**：克隆后消息体与每个 content block 都是新对象（防止下游投影
 *     误改源 transcript）。
 *  2. **保留 `undefined` 值字段**（负向对照）：`tool_call.input` 走 `structuredClone`、
 *     其余 block 走 spread，二者都保留显式 `undefined` 的自有键；若回退到 JSON 深拷贝，
 *     这些键会被整体丢弃 → 本用例转红。
 *  3. **tool_result 内层 content 逐元素克隆**、**tool_call.input 深克隆**（隔离嵌套改动）。
 *  4. **`raw` 共享引用**（文档化取舍：只读 provider 回显，从不改动）。
 *  5. **metadata 共享引用**：cloneMessage 只对 content 做逐块克隆，顶层 spread；
 *     下游 `flattenCanonicalMessage` 仅读不改，故共享安全（钉住此契约，防止误加深层拷贝）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cloneContentBlock, cloneMessage } from "../../../src/model/protocol/clone.js";
import type { CanonicalMessage } from "../../../src/model/protocol/canonical.js";

test("cloneMessage：顶层与 content 均为新引用，role/metadata 语义保持", () => {
  const raw = { provider: "echo" };
  const message: CanonicalMessage = {
    role: "assistant",
    // metadata 顶层 spread → 共享引用（下游只读，见文件头 5.）
    metadata: { synthetic: true, purpose: "clone-fixture" },
    content: [
      { type: "text", text: "hello" },
      { type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" }, raw },
    ],
  };

  const cloned = cloneMessage(message);

  assert.notEqual(cloned, message, "消息体是新对象");
  assert.equal(cloned.role, message.role);
  assert.equal(cloned.metadata, message.metadata, "metadata 顶层共享引用（契约：下游只读）");
  assert.notEqual(cloned.content, message.content, "content 数组是新引用");
  assert.equal(cloned.content.length, 2);
  assert.notEqual(cloned.content[0], message.content[0], "text block 是新引用");
  assert.notEqual(cloned.content[1], message.content[1], "tool_call block 是新引用");
  assert.deepEqual(cloned.content[0], { type: "text", text: "hello" });
});

test("cloneMessage：tool_call.raw 共享引用（文档化只读回显）", () => {
  const raw = { provider: "echo", nested: { keep: true } };
  const message: CanonicalMessage = {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "bash", input: { cmd: "ls" }, raw }],
  };
  const cloned = cloneMessage(message);
  const block = cloned.content[0] as { raw?: unknown };
  assert.equal(block.raw, raw, "raw 按文档保持共享引用，不做深拷贝");
});

test("cloneMessage：tool_call.input 深克隆——嵌套改动不回写源", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [{ type: "tool_call", id: "c1", name: "edit", input: { path: "a.ts", nested: { lines: [1, 2] } } }],
  };
  const cloned = cloneMessage(message);
  const clonedInput = (cloned.content[0] as { input: { nested: { lines: number[] } } }).input;
  const sourceInput = (message.content[0] as { input: { nested: { lines: number[] } } }).input;

  assert.notEqual(clonedInput, sourceInput, "input 是新引用（structuredClone）");
  clonedInput.nested.lines.push(3);
  assert.deepEqual(sourceInput.nested.lines, [1, 2], "改动克隆体不污染源 transcript");
});

test("cloneMessage：tool_result 内层 content 逐元素克隆为新引用", () => {
  const message: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId: "c1",
        isError: false,
        content: [
          { type: "text", text: "line-1" },
          { type: "text", text: "line-2" },
        ],
      },
    ],
  };
  const cloned = cloneMessage(message);
  const srcBlock = message.content[0] as { content: unknown[] };
  const clonedBlock = cloned.content[0] as { content: unknown[] };

  assert.notEqual(clonedBlock, srcBlock, "tool_result block 是新引用");
  assert.notEqual(clonedBlock.content, srcBlock.content, "内层 content 数组是新引用");
  assert.notEqual(clonedBlock.content[0], srcBlock.content[0], "内层元素逐个克隆（非共享）");
  assert.deepEqual(clonedBlock.content, srcBlock.content, "内容值一致");
});

/**
 * 负向对照（#535 核心）：显式 `undefined` 值的自有键必须被保留。
 * JSON.parse(JSON.stringify(...)) 会整体丢弃这些键；structuredClone / spread 不会。
 * 若有人把 cloneMessage 回退成 JSON 深拷贝，本用例的两处 `in` 断言立即转红。
 */
test("cloneMessage：保留显式 undefined 值字段（负向对照 JSON 深拷贝会丢键）", () => {
  const message: CanonicalMessage = {
    role: "assistant",
    content: [
      // thinking block 走默认 spread：signature 显式 undefined 应保留自有键
      { type: "thinking", text: "reasoning", signature: undefined },
      // tool_call.input 走 structuredClone：b 显式 undefined 应保留自有键
      { type: "tool_call", id: "c1", name: "bash", input: { a: 1, b: undefined } },
    ],
  };

  const cloned = cloneMessage(message);

  const thinking = cloned.content[0] as { signature?: string };
  assert.equal("signature" in thinking, true, "spread 保留 undefined 自有键（JSON 深拷贝会丢）");
  assert.equal(thinking.signature, undefined);

  const input = (cloned.content[1] as { input: Record<string, unknown> }).input;
  assert.equal("b" in input, true, "structuredClone 保留 undefined 自有键（JSON 深拷贝会丢）");
  assert.equal(input.b, undefined);
  assert.equal(input.a, 1);
});

test("cloneContentBlock：非 tool 类 block 走 spread（新引用 + 保留 undefined 键）", () => {
  const block = { type: "thinking", text: "t", reasoningContent: undefined } as const;
  const cloned = cloneContentBlock(block);
  assert.notEqual(cloned, block);
  assert.equal("reasoningContent" in cloned, true, "spread 保留 undefined 自有键");
  assert.deepEqual(cloned, block);
});

test("cloneMessage：content 非数组时归一为空数组（messageContent 容错）", () => {
  const message = { role: "assistant", content: undefined } as unknown as CanonicalMessage;
  const cloned = cloneMessage(message);
  assert.deepEqual(cloned.content, [], "非数组 content → []（不抛错）");
});
