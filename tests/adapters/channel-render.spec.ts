import test from "node:test";
import assert from "node:assert/strict";
import type { GatewayEvent } from "../../src/gateway/index.js";
import {
  isVisibleFailureAgentStatus,
  renderCliStyleEvent,
  renderPlainTextEvent,
} from "../../src/adapters/channel/protocol/render.js";
import { chunkText } from "../../src/adapters/channel/protocol/text.js";
import { resolveIncomingMessage } from "../../src/adapters/channel/protocol/ChannelCommandRegistry.js";
import { renderDiscordEvent } from "../../src/adapters/channel/discord/discord-render.js";
import { renderQQEvent } from "../../src/adapters/channel/qq/qq-render.js";
import { renderWeixinEvent } from "../../src/adapters/channel/weixin/weixin-render.js";
import { renderFeishuEvent } from "../../src/adapters/channel/feishu/feishu-render.js";
import { renderApiServerEvent } from "../../src/adapters/channel/api-server/api-server-render.js";
import { renderWebhookEvent } from "../../src/adapters/channel/webhook/webhook-render.js";

// ---------------------------------------------------------------------------
// renderPlainTextEvent — shared plain-text renderer
// ---------------------------------------------------------------------------

test("renderPlainTextEvent passes through assistant text and drops thinking deltas", () => {
  const textEvent: GatewayEvent = { type: "assistant_text_delta", text: "你好" };
  assert.equal(renderPlainTextEvent(textEvent), "你好");
  const thinkingEvent: GatewayEvent = { type: "assistant_thinking_delta", text: "reasoning…" };
  assert.equal(renderPlainTextEvent(thinkingEvent), "");
});

test("renderPlainTextEvent renders tool lifecycle", () => {
  const started: GatewayEvent = { type: "tool_call_started", toolCallId: "t1", name: "read_file" };
  assert.equal(renderPlainTextEvent(started), "");
  const ok: GatewayEvent = { type: "tool_call_finished", toolCallId: "t1", ok: true, toolName: "read_file" };
  assert.equal(renderPlainTextEvent(ok), "");
  const failed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t1",
    ok: false,
    toolName: "read_file",
    resultPreview: "EACCES: permission denied",
  };
  assert.equal(renderPlainTextEvent(failed), "\n⚠️ read_file failed\n");
});

test("renderPlainTextEvent renders elicitation questions as a numbered list", () => {
  const event: GatewayEvent = {
    type: "elicitation_request",
    requestId: "r1",
    toolCallId: "t1",
    toolName: "ask_user_question",
    questions: [
      {
        question: "继续？",
        header: "确认",
        options: [
          { label: "是", description: "" },
          { label: "否", description: "" },
        ],
      },
    ],
  };
  assert.equal(renderPlainTextEvent(event), "\n**确认**\n继续？\n1. 是\n2. 否\n");
});

test("renderPlainTextEvent renders errors and ignores unknown events", () => {
  const errorEvent: GatewayEvent = { type: "error", message: "boom", recoverable: false };
  assert.equal(renderPlainTextEvent(errorEvent), "\n❌ boom\n");
  const unknown: GatewayEvent = { type: "turn_started", runId: "run-1" };
  assert.equal(renderPlainTextEvent(unknown), undefined);
});

test("renderPlainTextEvent honors toolFailureLabel / skipToolNames / includeResultPreview", () => {
  const failed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t1",
    ok: false,
    toolName: "read_file",
    resultPreview: "  denied  ",
  };
  assert.equal(renderPlainTextEvent(failed, { toolFailureLabel: "执行失败" }), "\n⚠️ read_file 执行失败\n");
  assert.equal(renderPlainTextEvent(failed, { skipToolNames: new Set(["read_file"]) }), "");
  assert.equal(renderPlainTextEvent(failed, { includeResultPreview: true }), "\n⚠️ read_file failed\ndenied\n");
});

// ---------------------------------------------------------------------------
// renderCliStyleEvent — api-server / webhook renderer
// ---------------------------------------------------------------------------

test("renderCliStyleEvent renders tool progress lines", () => {
  const started: GatewayEvent = { type: "tool_call_started", toolCallId: "t1", name: "bash" };
  assert.equal(renderCliStyleEvent(started), "\n[bash running]\n");
  const done: GatewayEvent = { type: "tool_call_finished", toolCallId: "t1", ok: true, toolName: "bash" };
  assert.equal(renderCliStyleEvent(done), "\n[bash done]\n");
  const failed: GatewayEvent = { type: "tool_call_finished", toolCallId: "t1", ok: false, toolName: "bash" };
  assert.equal(renderCliStyleEvent(failed), "\n[bash failed]\n");
});

test("renderCliStyleEvent surfaces visible agent status failures with configurable prefix", () => {
  const failedStatus: GatewayEvent = {
    type: "agent_status",
    event: "turn_failed",
    detail: { visible: true, message: "模型请求失败" },
  };
  assert.equal(renderCliStyleEvent(failedStatus), "\nError: 模型请求失败\n");
  assert.equal(renderCliStyleEvent(failedStatus, { statusErrorPrefix: "\n⚠️" }), "\n⚠️ 模型请求失败\n");
  const invisible: GatewayEvent = {
    type: "agent_status",
    event: "turn_failed",
    detail: { visible: false, message: "内部错误" },
  };
  assert.equal(renderCliStyleEvent(invisible), undefined);
});

test("isVisibleFailureAgentStatus distinguishes failures from non-failures", () => {
  assert.equal(isVisibleFailureAgentStatus({ type: "agent_status", event: "turn_failed" }), true);
  assert.equal(isVisibleFailureAgentStatus({ type: "agent_status", event: "subagent_started" }), false);
  assert.equal(
    isVisibleFailureAgentStatus({ type: "agent_status", event: "turn_failed", detail: { visible: false } }),
    false,
  );
  assert.equal(isVisibleFailureAgentStatus({ type: "turn_started", runId: "r" }), false);
});

// ---------------------------------------------------------------------------
// Per-channel thin wrappers preserve previous behavior
// ---------------------------------------------------------------------------

test("channel thin wrappers preserve default / localized / special-cased rendering", () => {
  const failed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t1",
    ok: false,
    toolName: "read_file",
  };
  assert.equal(renderDiscordEvent(failed), "\n⚠️ read_file failed\n");
  assert.equal(renderQQEvent(failed), "\n⚠️ read_file 执行失败\n");

  const attachmentFailed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t1",
    ok: false,
    toolName: "send_attachment",
  };
  assert.equal(renderWeixinEvent(attachmentFailed), "");
  assert.equal(renderFeishuEvent(attachmentFailed), "");

  const previewFailed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t1",
    ok: false,
    toolName: "send_attachment",
    resultPreview: "disk full",
  };
  // feishu keeps the detail but still suppresses send_attachment failures
  assert.equal(renderFeishuEvent(previewFailed), "");
  const feishuToolFailed: GatewayEvent = {
    type: "tool_call_finished",
    toolCallId: "t2",
    ok: false,
    toolName: "bash",
    resultPreview: "exit 1",
  };
  assert.equal(renderFeishuEvent(feishuToolFailed), "\n⚠️ bash 执行失败\nexit 1\n");
});

test("api-server and webhook wrappers differ only in the status failure prefix", () => {
  const status: GatewayEvent = {
    type: "agent_status",
    event: "turn_timeout",
    detail: { visible: true, message: "turn timed out" },
  };
  assert.equal(renderApiServerEvent(status), "\nError: turn timed out\n");
  assert.equal(renderWebhookEvent(status), "\n⚠️ turn timed out\n");
  const text: GatewayEvent = { type: "assistant_text_delta", text: "hi" };
  assert.equal(renderApiServerEvent(text), "hi");
  assert.equal(renderWebhookEvent(text), "hi");
});

// ---------------------------------------------------------------------------
// chunkText — shared chunking utility
// ---------------------------------------------------------------------------

test("chunkText splits long text without empty tail chunks", () => {
  const short = "hello";
  assert.deepEqual(chunkText(short, 100), ["hello"]);
  assert.deepEqual(chunkText("aaaa", 4), ["aaaa"]);

  const long = "line one\nline two\nline three\nline four\n";
  const chunks = chunkText(long, 12);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(c => c.length <= 12));
  assert.ok(chunks.every(c => c.length > 0));
  // no empty trailing chunk when content ends exactly on a boundary
  assert.notEqual(chunks[chunks.length - 1], "");
  // each split happened on a newline boundary
  assert.deepEqual(chunks, ["line one", "line two", "line three", "line four\n"]);
});

// ---------------------------------------------------------------------------
// resolveIncomingMessage — shared "new session" handling
// ---------------------------------------------------------------------------

test("resolveIncomingMessage acks /new and skips empty messages", async () => {
  const replies: string[] = [];
  const sendReply = async (_chatId: string, text: string) => {
    replies.push(text);
  };
  const mapper = {
    resolve: (input: { chatId: string; text: string }) => ({
      sessionKey: `k:${input.chatId}`,
      command: input.text === "/new" ? ("new" as const) : undefined,
      message: input.text === "/new" ? "" : input.text,
    }),
  };

  const newRes = await resolveIncomingMessage(mapper, "c1", "/new", sendReply);
  assert.equal(newRes.handled, true);
  assert.deepEqual(replies, ["已创建新会话。"]);

  const emptyRes = await resolveIncomingMessage(mapper, "c1", "", sendReply);
  assert.equal(emptyRes.handled, true);

  const normalRes = await resolveIncomingMessage(mapper, "c1", "hello", sendReply);
  assert.equal(normalRes.handled, false);
  assert.equal(normalRes.mapped.message, "hello");
});
