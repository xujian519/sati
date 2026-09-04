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

test("buildTitleSystemPrompt requires the title to follow the user's language and infers a Chinese fallback for CJK input", () => {
  const zh = buildTitleSystemPrompt("帮我配置 Alacritty 终端");
  assert.match(zh, /same natural language as the user's input/);
  assert.match(zh, /Fallback language: Chinese/);
});

test("buildTitleSystemPrompt infers an English fallback for non-CJK input", () => {
  const en = buildTitleSystemPrompt("Explain Alacritty and create config");
  assert.match(en, /Fallback language: English/);
});

test("buildTitleSystemPrompt honors an explicit systemLanguage over input heuristics", () => {
  const forced = buildTitleSystemPrompt("Explain Alacritty and create config", "zh-CN");
  assert.match(forced, /Fallback language: Chinese/);
  const forcedEn = buildTitleSystemPrompt("帮我配置终端", "en");
  assert.match(forcedEn, /Fallback language: English/);
});

test("buildTitleSystemPrompt keeps bilingual few-shot examples for non-Chinese input too", () => {
  // 语言跟随指令与双语正例对所有输入生效——标题语言由指令驱动，不再由
  // prompt 二选一决定。注意：日文文本常含汉字（如"修正"），hasCjk 会判
  // true 而给中文兜底；兜底仅用于无法判断语言时，不影响主判定。
  const ja = buildTitleSystemPrompt("ログインボタンを修正する");
  assert.match(ja, /same natural language as the user's input/);
  assert.match(ja, /修复移动端登录按钮/);
  const fr = buildTitleSystemPrompt("Réparer le bouton de connexion mobile");
  assert.match(fr, /same natural language as the user's input/);
  assert.match(fr, /Fallback language: English/);
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

test("parseGeneratedTitle does not pick up a title from an array of objects", () => {
  // 合法 JSON 数组：即使元素带 title 也不提取（与嵌套字段同等对待）。
  assert.equal(parseGeneratedTitle(textContent('[{"title": "Debug failing CI tests"}]')), null);
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

test("createSessionTitleGenerator sends the language-following prompt with a Chinese fallback for Chinese input", async () => {
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
  assert.match(captured.systemPrompt ?? "", /same natural language as the user's input/);
  assert.match(captured.systemPrompt ?? "", /Fallback language: Chinese/);
});

test("createSessionTitleGenerator sends an English fallback for English input", async () => {
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
  assert.match(captured.systemPrompt ?? "", /Fallback language: English/);
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
