/**
 * 非用户来源护栏（`src/context/prompt/nonUserOriginNotice.ts`）。
 *
 * 这条护栏要挡的是「模型把后台/钩子/对等代理的文本读成用户指令或用户批准」——
 * 默认 `skipPermissions: true` 下，任何被读成「已获批准」的信号都会直接放行。
 *
 * 同时锁住它与压缩锚点机制的相互作用：锚点判定按文本前缀排除内部消息
 * （`INTERNAL_USER_TEXT_PREFIXES`），护栏抬头若压到最前面，被注入的钩子上下文
 * 就会退化成「真实用户请求」并被当作锚点保留。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  NON_USER_ORIGIN_MARKER,
  NON_USER_ORIGIN_NOTICE,
  withNonUserOriginNotice,
} from "../../src/context/prompt/nonUserOriginNotice.js";
import { isRealUserRequestMessage } from "../../src/context/compaction/toolPairIntegrity.js";
import type { CanonicalMessage } from "../../src/model/index.js";

test("护栏：抬头与说明居首，原始文本完整保留在末尾", () => {
  const annotated = withNonUserOriginNotice("任务 T-1 已完成");
  assert.ok(annotated.startsWith(`${NON_USER_ORIGIN_MARKER}\n`));
  assert.ok(annotated.includes(NON_USER_ORIGIN_NOTICE));
  assert.ok(annotated.endsWith("任务 T-1 已完成"));
});

test("护栏：幂等（同一文本依次经过两层注入点不会叠加抬头）", () => {
  const once = withNonUserOriginNotice("payload");
  assert.equal(withNonUserOriginNotice(once), once);
});

test("护栏：空文本也带上抬头（不产生裸空消息）", () => {
  assert.ok(withNonUserOriginNotice("").startsWith(NON_USER_ORIGIN_MARKER));
});

test("护栏：真实用户消息不带抬头（不改动用户输入）", () => {
  const user: CanonicalMessage = { role: "user", content: [{ type: "text", text: "继续撰写权利要求" }] };
  assert.ok(!(user.content[0] as { text: string }).text.includes(NON_USER_ORIGIN_MARKER));
  assert.equal(isRealUserRequestMessage(user), true);
});

test("护栏：带抬头的钩子上下文仍被压缩锚点判定排除", () => {
  // 复刻 LifecycleRuntime 的构形：护栏在标签内、`<hook_context` 居首。
  const hookContext: CanonicalMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `<hook_context source="plugin-a">\n${withNonUserOriginNotice("ctx body")}\n</hook_context>`,
      },
    ],
    metadata: { synthetic: true, purpose: "hook_context" },
  };
  assert.ok((hookContext.content[0] as { text: string }).text.startsWith("<hook_context"));
  assert.equal(isRealUserRequestMessage(hookContext), false);
});

test("护栏：抬头压在最前面时锚点判定会失守（记录该约束为何必须遵守）", () => {
  // 反例：这正是实现里「护栏放进标签内」的原因。若护栏外包标签，
  // `<hook_context` 不再居首 → 该消息在缺 metadata 时被当成真实用户请求。
  const wrappedContent = withNonUserOriginNotice('<hook_context source="plugin-a">\nctx body\n</hook_context>');
  const tagFirstContent = `<hook_context source="plugin-a">\n${withNonUserOriginNotice("ctx body")}\n</hook_context>`;
  // 有 metadata.synthetic 时仍是内部消息（最后一道防线）。
  assert.equal(
    isRealUserRequestMessage({
      role: "user",
      content: [{ type: "text", text: wrappedContent }],
      metadata: { synthetic: true, purpose: "hook_context" },
    }),
    false,
  );
  // 一旦 metadata 在历史 transcript 中缺失（旧记录/投影剥离），前缀就是唯一防线——
  // 包裹式护栏此时会失守，标签内置则不会。
  assert.equal(
    isRealUserRequestMessage({ role: "user", content: [{ type: "text", text: wrappedContent }] }),
    true,
    "包裹式护栏在无 metadata 时失守",
  );
  assert.equal(
    isRealUserRequestMessage({ role: "user", content: [{ type: "text", text: tagFirstContent }] }),
    false,
    "标签内置时前缀防线仍有效",
  );
});
