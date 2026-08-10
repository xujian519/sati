import test from "node:test";
import assert from "node:assert/strict";
import type { CanonicalModelRequest, CanonicalModelResponse } from "../../../src/model/index.js";
import {
  buildTitleSystemPrompt,
  createSessionTitleGenerator,
  hasCjk,
  parseGeneratedTitle,
} from "../../../src/session/title/SessionTitleGenerator.js";

const textContent = (text: string) => [{ type: "text" as const, text }];

// ---------------------------------------------------------------------------
// 语言选择
// ---------------------------------------------------------------------------

test("hasCjk detects Chinese characters", () => {
  assert.equal(hasCjk("帮我配置 Alacritty"), true);
  assert.equal(hasCjk("纯中文消息"), true);
  assert.equal(hasCjk("Explain Alacritty and create config"), false);
  assert.equal(hasCjk("just code: const x = 1;"), false);
});

test("buildTitleSystemPrompt picks the Chinese prompt when input contains CJK", () => {
  const zh = buildTitleSystemPrompt("帮我配置 Alacritty 终端");
  assert.match(zh, /为本次会话生成一个简洁的标题/);
  assert.doesNotMatch(zh, /Generate a concise/);
});

test("buildTitleSystemPrompt picks the English prompt for non-CJK input", () => {
  const en = buildTitleSystemPrompt("Explain Alacritty and create config");
  assert.match(en, /Generate a concise/);
  assert.doesNotMatch(en, /为本次会话生成一个简洁的标题/);
});

// ---------------------------------------------------------------------------
// JSON 解析兜底
// ---------------------------------------------------------------------------

test("parseGeneratedTitle extracts title from valid JSON", () => {
  assert.equal(
    parseGeneratedTitle(textContent('{"title": "Fix login button on mobile"}')),
    "Fix login button on mobile",
  );
});

test("parseGeneratedTitle extracts title from JSON inside a code fence", () => {
  const fenced = '```json\n{"title": "Add OAuth authentication"}\n```';
  assert.equal(parseGeneratedTitle(textContent(fenced)), "Add OAuth authentication");
});

test("parseGeneratedTitle extracts Chinese title from valid JSON", () => {
  assert.equal(parseGeneratedTitle(textContent('{"title": "修复移动端登录按钮"}')), "修复移动端登录按钮");
});

test("parseGeneratedTitle recovers a title from single-quoted JSON", () => {
  assert.equal(parseGeneratedTitle(textContent("{'title': '修复移动端登录按钮'}")), "修复移动端登录按钮");
});

test("parseGeneratedTitle recovers a title from JSON wrapped in prose", () => {
  const prose = 'Here is the title: {"title": "Debug failing CI tests"}. Enjoy!';
  assert.equal(parseGeneratedTitle(textContent(prose)), "Debug failing CI tests");
});

test("parseGeneratedTitle recovers a title separated by a full-width colon", () => {
  assert.equal(parseGeneratedTitle(textContent('{"title"： "修复移动端登录按钮"}')), "修复移动端登录按钮");
});

test("parseGeneratedTitle falls back to plain text when the model skips JSON", () => {
  // 之前这类输出会记 invalid_json 并放弃标题。
  assert.equal(parseGeneratedTitle(textContent("Fix login button on mobile")), "Fix login button on mobile");
});

test("parseGeneratedTitle returns null for a JSON object without a title field", () => {
  assert.equal(parseGeneratedTitle(textContent('{"foo": "bar"}')), null);
});

test("parseGeneratedTitle returns null for a JSON array", () => {
  assert.equal(parseGeneratedTitle(textContent('["a", "b"]')), null);
});

test("parseGeneratedTitle does not pick up a nested title field", () => {
  // 合法 JSON 但缺顶层 title：不能从嵌套字段误提取。
  assert.equal(parseGeneratedTitle(textContent('{"foo": {"title": "nested"}}')), null);
});

test("parseGeneratedTitle returns null for empty output", () => {
  assert.equal(parseGeneratedTitle(textContent("")), null);
  assert.equal(parseGeneratedTitle([]), null);
});

test("parseGeneratedTitle returns null for an empty title value", () => {
  assert.equal(parseGeneratedTitle(textContent('{"title": ""}')), null);
});

test("parseGeneratedTitle collapses whitespace and truncates over-long titles", () => {
  const longTitle = "x".repeat(200);
  const result = parseGeneratedTitle(textContent(JSON.stringify({ title: longTitle })));
  assert.equal(result, "x".repeat(80));
});

// ---------------------------------------------------------------------------
// 集成：createSessionTitleGenerator
// ---------------------------------------------------------------------------

function createGeneratorWithMock(respond: (systemPrompt: string | undefined) => CanonicalModelResponse) {
  const captured: { systemPrompt?: string } = {};
  const generator = createSessionTitleGenerator({
    modelRuntime: {
      complete: async (request: CanonicalModelRequest) => {
        captured.systemPrompt = request.systemPrompt;
        return respond(request.systemPrompt);
      },
    },
    agentModel: { id: "test", provider: "test-provider", model: "test-model" },
  });
  return { generator, captured };
}

test("createSessionTitleGenerator uses the Chinese prompt and returns a Chinese title", async () => {
  const { generator, captured } = createGeneratorWithMock(() => ({
    role: "assistant",
    content: [{ type: "text", text: '{"title": "修复移动端登录按钮"}' }],
    finishReason: "stop",
  }));

  const title = await generator({
    text: "帮我修复移动端登录按钮的问题",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "修复移动端登录按钮");
  assert.match(captured.systemPrompt ?? "", /为本次会话生成一个简洁的标题/);
});

test("createSessionTitleGenerator uses the English prompt for English input", async () => {
  const { generator, captured } = createGeneratorWithMock(() => ({
    role: "assistant",
    content: [{ type: "text", text: '{"title": "Fix login button on mobile"}' }],
    finishReason: "stop",
  }));

  const title = await generator({
    text: "Fix the login button on mobile",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "Fix login button on mobile");
  assert.match(captured.systemPrompt ?? "", /Generate a concise/);
});

test("createSessionTitleGenerator keeps the title when the model returns plain text", async () => {
  const { generator } = createGeneratorWithMock(() => ({
    role: "assistant",
    content: [{ type: "text", text: "修复移动端登录按钮" }],
    finishReason: "stop",
  }));

  const title = await generator({
    text: "帮我修复移动端登录按钮的问题",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, "修复移动端登录按钮");
});

test("createSessionTitleGenerator returns null when the model throws", async () => {
  const generator = createSessionTitleGenerator({
    modelRuntime: {
      complete: async () => {
        throw new Error("provider down");
      },
    },
    agentModel: { id: "test", provider: "test-provider", model: "test-model" },
  });

  const title = await generator({
    text: "anything",
    sessionId: "s1",
    turnId: "t1",
    signal: new AbortController().signal,
  });

  assert.equal(title, null);
});
