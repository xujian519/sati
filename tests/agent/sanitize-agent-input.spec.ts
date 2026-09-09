/**
 * 用户输入外发脱敏测试（W1）。
 *
 * 覆盖：三类凭证（API key / URL userinfo / 密码赋值）正反用例、
 * AgentInput 两种形态（text / blocks 仅 text block）、redacted 标记语义、
 * TurnRunner 接线集成（脱敏先于 accept + payload_redacted 告警）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REDACTED_API_KEY,
  REDACTED_CREDENTIALS,
  REDACTED_SECURE_TOKEN,
  sanitizeAgentInput,
  sanitizeOutgoingText,
} from "../../src/agent/turn/sanitizeAgentInput.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../src/agent/protocol/result.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { InMemoryTranscriptWriter } from "../../src/session/transcript/InMemoryTranscriptWriter.js";

test("sanitizeOutgoingText：API key 命中并替换", () => {
  const { text, redacted } = sanitizeOutgoingText("我的配置是 sk-abcdefghijklmnop123456 请检查");
  assert.equal(redacted, true);
  assert.equal(text, `我的配置是 ${REDACTED_API_KEY} 请检查`);
});

test("sanitizeOutgoingText：各类 key 前缀均命中", () => {
  for (const key of [
    "sk-ant-abcdefghijklmnopqrst",
    "xai-abcdefghijklmnopqrst",
    "AIzaSyA1234567890abcd",
    "ghp_abcdefghijklmnopqrst",
    "gho_abcdefghijklmnopqrst",
    "glpat_-abcdefghijklmnopqrs",
  ]) {
    const { redacted } = sanitizeOutgoingText(`token: ${key}`);
    assert.equal(redacted, true, key);
  }
});

test("sanitizeOutgoingText：短串与普通文本不误伤", () => {
  for (const text of [
    "sk-47",
    "sk-",
    "编号 sk-1234 不构成密钥",
    "CH3-CH2-OH 化学式 sk-short",
    "普通段落，无任何凭证内容",
  ]) {
    const result = sanitizeOutgoingText(text);
    assert.equal(result.redacted, false, text);
    assert.equal(result.text, text);
  }
});

test("sanitizeOutgoingText：URL userinfo 凭证替换", () => {
  const { text, redacted } = sanitizeOutgoingText("见 https://user:secret@example.com/path");
  assert.equal(redacted, true);
  assert.equal(text, `见 https://user:${REDACTED_CREDENTIALS}@example.com/path`);
});

test("sanitizeOutgoingText：URL userinfo 之外的冒号文本不误伤", () => {
  const text = "比例 a:b@c 附近，时间 12:30，端口 localhost:3001";
  const result = sanitizeOutgoingText(text);
  assert.equal(result.redacted, false);
  assert.equal(result.text, text);
});

test("sanitizeOutgoingText：密码赋值替换", () => {
  const { text, redacted } = sanitizeOutgoingText('password = "hunter2"');
  assert.equal(redacted, true);
  assert.equal(text, `password = "${REDACTED_SECURE_TOKEN}"`);
});

test("sanitizeOutgoingText：单引号密码保留原引号风格（review Minor #8）", () => {
  const { text, redacted } = sanitizeOutgoingText("password: 'hunter2'");
  assert.equal(redacted, true);
  assert.equal(text, `password: '${REDACTED_SECURE_TOKEN}'`);
});

test("sanitizeOutgoingText：password 出现在非赋值语境不误伤", () => {
  const text = "请重置 password 字段后重试";
  const result = sanitizeOutgoingText(text);
  assert.equal(result.redacted, false);
});

test("sanitizeAgentInput：text 形态透传与脱敏", () => {
  const clean = sanitizeAgentInput({ type: "text", text: "普通问题" });
  assert.equal(clean.redacted, false);
  assert.deepEqual(clean.input, { type: "text", text: "普通问题" });

  const dirty = sanitizeAgentInput({ type: "text", text: "key: sk-abcdefghijklmnop1234" });
  assert.equal(dirty.redacted, true);
  assert.equal(dirty.input.type, "text");
  if (dirty.input.type === "text") {
    assert.equal(dirty.input.text, `key: ${REDACTED_API_KEY}`);
  }
});

test("sanitizeAgentInput：blocks 形态仅脱敏 text block", () => {
  const imageBlock = {
    type: "image",
    source: "base64",
    data: "aGVsbG8=",
    mimeType: "image/png",
  } as const;
  const dirty = sanitizeAgentInput({
    type: "blocks",
    content: [{ type: "text", text: "日志含 https://admin:pass@example.com/api" }, imageBlock],
  });
  assert.equal(dirty.redacted, true);
  if (dirty.input.type === "blocks") {
    assert.equal(dirty.input.content[0]!.type, "text");
    const first = dirty.input.content[0] as { type: "text"; text: string };
    assert.equal(first.text, `日志含 https://admin:${REDACTED_CREDENTIALS}@example.com/api`);
    assert.deepEqual(dirty.input.content[1], imageBlock);
  }
});

// ---------------------------------------------------------------------------
// TurnRunner 集成（review Minor #9：固化「脱敏先于 accept」不变式）
// ---------------------------------------------------------------------------

const RESULT: AgentTurnResult = {
  type: "success",
  sessionId: "session-1",
  turnId: "turn-1",
  stopReason: "completed",
  usage: {},
  permissionDenials: [],
  turns: 1,
  startedAt: "2026-09-09T10:00:00.000Z",
  completedAt: "2026-09-09T10:00:01.000Z",
};

function makeFakeLoop(seenByLoop?: string[]): AgentLoop {
  return {
    async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
      for (const message of input.messages) {
        for (const block of message.content) {
          if (block.type === "text") seenByLoop?.push(block.text);
        }
      }
      yield { type: "turn_completed", sessionId: input.sessionId, turnId: input.turnId, result: RESULT };
      return { result: RESULT, messages: input.messages };
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
}

function makeRunner(loop: AgentLoop, transcript: InMemoryTranscriptWriter): TurnRunner {
  return new TurnRunner(loop, transcript, undefined, () => new Date("2026-09-09T10:00:01.000Z"), undefined, {
    cwd: "/workspace",
    transcriptPath: "",
  });
}

async function collectRunnerEvents(runner: TurnRunner, input: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of runner.run({
    sessionId: "session-1",
    turnId: "turn-1",
    messages: [],
    input: { type: "text", text: input },
  })) {
    events.push(event);
  }
  return events;
}

test("TurnRunner：脱敏先于 accept，模型可见与事件流均为脱敏文本并发出告警", async () => {
  const seenByLoop: string[] = [];
  const transcript = new InMemoryTranscriptWriter();
  const events = await collectRunnerEvents(
    makeRunner(makeFakeLoop(seenByLoop), transcript),
    "我的 key 是 sk-abcdefghijklmnop1234 请检查日志",
  );

  // 模型可见消息已脱敏，原文密钥不出现在任何下游面
  const userText = seenByLoop.join("\n");
  assert.ok(userText.includes(REDACTED_API_KEY));
  assert.ok(!userText.includes("sk-abcdefghijklmnop1234"));
  // input_accepted / user_prompt_submitted 事件同样不回带密钥
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes("sk-abcdefghijklmnop1234"));
  assert.ok(serialized.includes(REDACTED_API_KEY));
  // 脱敏发生时有 payload_redacted 告警
  assert.ok(events.some(event => event.type === "warning" && event.code === "payload_redacted"));
  // transcript 落库的是脱敏输入
  const acceptedEntry = transcript.entries.find(entry => entry.type === "accepted_input");
  assert.ok(acceptedEntry);
  assert.ok(!JSON.stringify(acceptedEntry).includes("sk-abcdefghijklmnop1234"));
});

test("TurnRunner：无凭证输入不发出 payload_redacted 告警", async () => {
  const events = await collectRunnerEvents(
    makeRunner(makeFakeLoop(), new InMemoryTranscriptWriter()),
    "普通问题，无凭证",
  );
  assert.ok(!events.some(event => event.type === "warning" && event.code === "payload_redacted"));
});
