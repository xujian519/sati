import test from "node:test";
import assert from "node:assert/strict";
import { projectToolResults } from "../../src/agent/loop/projectToolResults.js";
import {
  buildPostCompactMessages,
  CompactionEngine,
  truncateHeadPreservingCheckpoint,
} from "../../src/context/index.js";
import { SnipEngine } from "../../src/context/compaction/SnipEngine.js";
import { COMPACT_SUMMARY_PREFIX } from "../../src/context/compaction/summaryBuilders.js";
import { isRealUserRequestMessage } from "../../src/context/compaction/toolPairIntegrity.js";
import type { CanonicalMessage, CanonicalModelEvent } from "../../src/model/index.js";

const CONTINUATION_TEXT = "[system: the conversation above has been compacted. please continue with the current task.]";

function user(text: string, metadata?: CanonicalMessage["metadata"]): CanonicalMessage {
  return { role: "user", content: [{ type: "text", text }], metadata };
}

function assistant(text: string): CanonicalMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function toolResult(toolCallId: string): CanonicalMessage {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        toolCallId,
        content: [{ type: "text", text: "result of " + toolCallId }],
      },
    ],
  };
}

test("isRealUserRequestMessage accepts a plain end-user request and rejects internal messages", () => {
  assert.equal(isRealUserRequestMessage(user("Continue the patent draft")), true);
  assert.equal(isRealUserRequestMessage(user("Continue the patent draft", { synthetic: true })), false);
  assert.equal(isRealUserRequestMessage(toolResult("tc-1")), false);
  assert.equal(
    isRealUserRequestMessage({
      role: "user",
      content: [
        {
          type: "media_reference",
          toolCallId: "tc-1",
          path: "/tmp/a.png",
          mimeType: "image/png",
          originalBytes: 100,
          preview: "preview",
          hasMore: false,
          mediaType: "image",
        },
      ],
    }),
    false,
  );
  assert.equal(isRealUserRequestMessage(user(CONTINUATION_TEXT)), false);
  assert.equal(isRealUserRequestMessage(user('<compact-boundary trigger="auto" />')), false);
  assert.equal(isRealUserRequestMessage(user('<snip-boundary turnsSnipped="2" />')), false);
  assert.equal(isRealUserRequestMessage(user("<memory-context>context</memory-context>")), false);
  assert.equal(
    isRealUserRequestMessage(user('<internal-compaction-control purpose="context-summary" synthetic="true">')),
    false,
  );
  assert.equal(isRealUserRequestMessage(user('<hook_context source="plugin-a">\nctx\n</hook_context>')), false);
  // 文本与工具结果混合的消息仍算真实请求（锚点判定按 block 逐个排除）。
  assert.equal(
    isRealUserRequestMessage({
      role: "user",
      content: [{ type: "text", text: "keep going" }, ...toolResult("tc-1").content],
    }),
    true,
  );
});

test("truncateHeadPreservingCheckpoint keeps the user request that initiated the tail", () => {
  const messages = [
    user("Older work"),
    assistant("older response"),
    user("Anchor request"),
    assistant("anchor response"),
    user("Latest tail request"),
    assistant("latest response"),
  ];
  // 0.5 比例截掉头部一半："Anchor request" 落在截断点前，必须作为锚点保留。
  const out = truncateHeadPreservingCheckpoint(messages, 0.5);
  assert.ok(
    out.some(message => textOf(message) === "Anchor request"),
    "anchor request must survive",
  );
  assert.ok(
    out.some(message => textOf(message) === "Latest tail request"),
    "latest tail must survive",
  );
  assert.ok(!out.some(message => textOf(message) === "Older work"), "older head must be dropped");
});

test("truncateHeadPreservingCheckpoint preserves the compact boundary + summary prefix verbatim", () => {
  const messages = [
    user('<compact-boundary trigger="auto" preTokens="100" messagesSummarized="2" status="ok" />'),
    {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `${COMPACT_SUMMARY_PREFIX}\n\n## Objective\nContinue.\n\n--- END OF CONTEXT SUMMARY - respond to the message below, not the summary above ---`,
        },
      ],
    } satisfies CanonicalMessage,
    user("Live request"),
    assistant("live response"),
    user("Tool call turn"),
    assistant("Latest tail"),
  ];
  const out = truncateHeadPreservingCheckpoint(messages, 0.5);
  assert.ok(out[0]?.role === "user" && textOf(out[0]).startsWith("<compact-boundary"));
  assert.ok(
    out.some(message => message.role === "assistant" && textOf(message).startsWith(COMPACT_SUMMARY_PREFIX)),
    "accepted summary prefix must stay",
  );
  assert.ok(
    out.some(message => textOf(message) === "Tool call turn"),
    "anchor in the live tail must stay",
  );
});

test("truncateHeadPreservingCheckpoint strips dangling tool calls and appends a trailing user message", () => {
  const messages = [
    user("Anchor request"),
    {
      role: "assistant",
      content: [
        { type: "text", text: "let me look" },
        { type: "tool_call", id: "call-1", name: "read_file", input: { path: "a.ts" } },
      ],
    } satisfies CanonicalMessage,
    user("Latest"),
    assistant("ok"),
  ];
  const out = truncateHeadPreservingCheckpoint(messages, 0.5);
  // 尾部的 dangling tool_call（无配对 tool_result）被剥离。
  assert.ok(!out.some(message => message.content.some(block => block.type === "tool_call")));
  // 结尾是 assistant 时补 sentinel user 消息。
  const last = out.at(-1)!;
  assert.equal(last.role, "user");
  assert.equal(last.content[0]?.type, "text");
});

test("snip keeps the most recent real user request that was about to be snipped", () => {
  const engine = new SnipEngine({ keepHeadTurns: 1, keepTailTurns: 1 });
  const messages = [
    user("First"),
    assistant("first response"),
    user("Anchor request"),
    assistant("anchor response"),
    user("Latest tail request"),
    assistant("latest response"),
    user('<snip-boundary turnsSnipped="0" headTurns="1" tailTurns="1" />'),
  ];
  const result = engine.snip(messages);
  assert.equal(result.applied, true);
  const texts = result.messages.map(textOf);
  assert.ok(texts.includes("Latest tail request"), "anchor request must be kept");
  assert.ok(!texts.includes("Anchor request"), "deeper middle turn must be snipped");
  // 锚点保留后，boundary 标记插在被剪区与锚点之间。
  const anchorIndex = result.messages.findIndex(message => textOf(message) === "Latest tail request");
  assert.ok(anchorIndex > 0);
  assert.ok(texts.slice(0, anchorIndex).some(text => text.startsWith("<snip-boundary")));
});

test("full compaction keeps the latest user request anchored before the tail boundary", async () => {
  const engine = new CompactionEngine({
    model: {
      async *stream(): AsyncIterable<CanonicalModelEvent> {
        yield { type: "message_start", role: "assistant" };
        yield {
          type: "text_delta",
          text: "## Objective\nContinue.\n\n## Current State\nCompacted.\n\n## Remaining\nContinue.\n\n## Files And Artifacts\nNone.",
        };
        yield { type: "message_end", finishReason: "stop" };
      },
    },
    provider: "local",
    model_: "local-chat",
  });

  const result = await engine.run({
    trigger: "auto",
    keepTailRatio: 0.01,
    // 尾部 token 预算只够 1 个 turn（hook_context）：最近的真实用户请求
    // "Latest tail request" 落在被摘要区，必须作为锚点保留 verbatim。
    protectedToolNames: null,
    messages: [
      user("Older work"),
      assistant("older response"),
      user("Anchor request"),
      assistant("anchor response"),
      user("Latest tail request"),
      assistant("latest response"),
      user('<hook_context source="plugin-a">\nctx\n</hook_context>'),
    ],
  });

  const compacted = buildPostCompactMessages(result);
  const texts = compacted.map(textOf);
  assert.ok(texts.includes("Latest tail request"), "anchored user request must be kept verbatim");
  assert.ok(!texts.includes("Anchor request"), "earlier turns must be summarized away");
  assert.ok(!texts.includes("Older work"), "oldest turns must be summarized away");
});

test("projected supplemental tool messages carry synthetic metadata with the originating tool call", () => {
  const messages = projectToolResults([
    {
      type: "success",
      toolCallId: "tc-supp-1",
      toolName: "patent_search",
      content: [],
      supplementalMessages: [{ role: "user", content: [{ type: "text", text: "supplemental hint" }] }],
      startedAt: "2026-08-19T00:00:00.000Z",
      completedAt: "2026-08-19T00:00:01.000Z",
    },
  ]);
  assert.equal(messages.length, 2);
  const supplemental = messages[1]!;
  assert.equal(supplemental.role, "user");
  assert.deepEqual(supplemental.metadata, {
    synthetic: true,
    purpose: "tool_result_supplemental",
    toolCallId: "tc-supp-1",
  });
});

function textOf(message: CanonicalMessage): string {
  return message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("");
}
