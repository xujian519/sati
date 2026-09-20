/**
 * `extractModelWindows`：从各协议 `/models` 响应里抽窗口事实。
 *
 * 重点覆盖两类失效：① 拿不到窗口时**不产出条目**（宁缺勿错，避免写入错的持久值）；
 * ② 宽松匹配把输出配额当上下文窗口（`max_tokens` 陷阱）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractModelWindows } from "../../../src/model/window/extract.js";

test("openai 形状不含窗口字段时不产出条目", () => {
  const hits = extractModelWindows({
    object: "list",
    data: [{ id: "gpt-4o", object: "model", created: 1, owned_by: "openai" }],
  });
  assert.deepEqual(hits, []);
});

test("OpenRouter：顶层 context_length 与 top_provider 容器的 max_completion_tokens", () => {
  const hits = extractModelWindows({
    data: [
      {
        id: "anthropic/claude-sonnet-4.6",
        context_length: 200000,
        top_provider: { context_length: 1000000, max_completion_tokens: 64000 },
      },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.modelId, "anthropic/claude-sonnet-4.6");
  // 顶层在容器之先命中：顶层键可信度更高。
  assert.equal(hits[0]?.maxContextTokens, 200000);
  assert.equal(hits[0]?.contextVia, "context_length");
  assert.equal(hits[0]?.maxOutputTokens, 64000);
  assert.equal(hits[0]?.outputVia, "max_completion_tokens");
});

test("Google：models[].inputTokenLimit/outputTokenLimit，且剥掉 models/ 前缀", () => {
  const hits = extractModelWindows({
    models: [{ name: "models/gemini-2.0-flash", inputTokenLimit: 1048576, outputTokenLimit: 8192 }],
  });
  assert.deepEqual(hits, [
    {
      modelId: "gemini-2.0-flash",
      maxContextTokens: 1048576,
      contextVia: "inputTokenLimit",
      maxOutputTokens: 8192,
      outputVia: "outputTokenLimit",
    },
  ]);
});

test("Ollama：details 容器里的 context_length", () => {
  const hits = extractModelWindows({ models: [{ name: "llama3.2", details: { context_length: 131072 } }] });
  assert.equal(hits[0]?.modelId, "llama3.2");
  assert.equal(hits[0]?.maxContextTokens, 131072);
  assert.equal(hits[0]?.contextVia, "context_length");
});

test("llama.cpp：meta 容器里的 n_ctx_train", () => {
  const hits = extractModelWindows({ data: [{ id: "qwen2.5", meta: { n_ctx_train: 32768 } }] });
  assert.equal(hits[0]?.maxContextTokens, 32768);
  assert.equal(hits[0]?.contextVia, "n_ctx_train");
});

test("Anthropic：max_input_tokens 作为窗口、max_tokens 作为输出上限", () => {
  const hits = extractModelWindows({
    data: [{ id: "claude-sonnet-4.6", max_input_tokens: 200000, max_tokens: 64000 }],
  });
  assert.equal(hits[0]?.maxContextTokens, 200000);
  assert.equal(hits[0]?.maxOutputTokens, 64000);
});

test("单独的 max_tokens 不得被当作上下文窗口", () => {
  const hits = extractModelWindows({ data: [{ id: "some-proxy-model", max_tokens: 4096 }] });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.maxContextTokens, undefined);
  assert.equal(hits[0]?.maxOutputTokens, 4096);
});

test("区间校验：过小/过大/非数字一律丢弃该维度", () => {
  const hits = extractModelWindows({
    data: [
      { id: "too-small", context_length: 512 },
      { id: "too-large", context_length: 999_000_000 },
      { id: "nan", context_length: "abc" },
      { id: "bool", context_length: true },
    ],
  });
  assert.deepEqual(hits, []);
});

test("纯数字字符串被接受（部分站点把窗口序列化成字符串）", () => {
  const hits = extractModelWindows({ data: [{ id: "stringy", context_length: "262144" }] });
  assert.equal(hits[0]?.maxContextTokens, 262144);
});

test("裸数组与畸形输入", () => {
  assert.equal(extractModelWindows([{ id: "a", context_length: 8192 }])[0]?.maxContextTokens, 8192);
  assert.deepEqual(extractModelWindows(null), []);
  assert.deepEqual(extractModelWindows({}), []);
  assert.deepEqual(extractModelWindows({ data: "nope" }), []);
  assert.deepEqual(extractModelWindows({ data: [null, 1, "x"] }), []);
});

test("同一 modelId 去重（保留先出现者）", () => {
  const hits = extractModelWindows({
    data: [
      { id: "dup", context_length: 8192 },
      { id: "dup", context_length: 65536 },
    ],
  });
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.maxContextTokens, 8192);
});

test("缺少模型标识的条目跳过", () => {
  assert.deepEqual(extractModelWindows({ data: [{ context_length: 8192 }] }), []);
});
