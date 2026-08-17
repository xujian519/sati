import assert from "node:assert/strict";
import test from "node:test";
import {
  llmNode,
  isDegraded,
  getDegradationMark,
  type StageProvider,
  type GraphNode,
} from "../../../src/patent/index.js";
import type { GraphState, StateDelta } from "../../../src/patent/graph/types.js";

const SCHEMA = {
  type: "object",
  properties: {
    foo: { type: "string" },
    bar: { type: "string" },
  },
  required: ["foo", "bar"],
} as const;

/** 直接执行单个节点（绕过引擎，聚焦 llmNode 行为）。 */
async function runNode(node: GraphNode, provider: StageProvider, state: GraphState = {}): Promise<StateDelta> {
  return node({ state, provider });
}

test("llmNode: 第一次 reject、第二次成功 → 正常输出、无降级（maxAttempts=2）", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      if (calls === 1) throw new Error("瞬时错误");
      return JSON.stringify({ foo: "a", bar: "b" });
    },
  };
  const delta = await runNode(
    llmNode({ outputKey: "out", maxAttempts: 2, schema: SCHEMA, buildPrompt: () => "p" }),
    provider,
  );
  assert.equal(delta.out, JSON.stringify({ foo: "a", bar: "b" }));
  assert.equal(calls, 2);
  assert.equal(delta.out__degradation, undefined, "不应降级");
});

test("llmNode: 两次都 reject → 降级，原因含最后一次错误", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      throw new Error(`err-${calls}`);
    },
  };
  const delta = await runNode(
    llmNode({ outputKey: "out", maxAttempts: 2, schema: SCHEMA, buildPrompt: () => "p" }),
    provider,
  );
  assert.equal(delta.out, "", "降级 fallback 为空");
  const mark = delta.out__degradation as { reason: string; message: string };
  assert.equal(mark.reason, "llm_unavailable");
  assert.ok((mark.message as string).includes("err-2"), "原因应含最后一次错误: " + mark.message);
});

test("llmNode: 返回缺 required 字段的 JSON → 触发重试，第二次合法 → 成功", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      return calls === 1 ? JSON.stringify({ foo: "a" }) : JSON.stringify({ foo: "a", bar: "b" });
    },
  };
  const delta = await runNode(
    llmNode({ outputKey: "out", maxAttempts: 2, schema: SCHEMA, buildPrompt: () => "p" }),
    provider,
  );
  assert.equal(delta.out, JSON.stringify({ foo: "a", bar: "b" }));
  assert.equal(calls, 2);
  assert.equal(delta.out__degradation, undefined);
});

test("llmNode: 非 JSON 输出（有 schema）→ 重试后仍失败 → 降级", async () => {
  const provider: StageProvider = {
    callLLM: async () => "这不是 JSON",
  };
  const delta = await runNode(
    llmNode({ outputKey: "out", maxAttempts: 2, schema: SCHEMA, buildPrompt: () => "p" }),
    provider,
  );
  assert.equal(delta.out, "");
  assert.ok((delta.out__degradation as { message: string }).message.includes("JSON 校验失败"));
});

test("llmNode: 无 schema 节点行为与旧版一致（文本原样返回，JSON 不校验）", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      return "自由文本输出";
    },
  };
  const delta = await runNode(llmNode({ outputKey: "out", buildPrompt: () => "p" }), provider);
  assert.equal(delta.out, "自由文本输出");
  assert.equal(calls, 1);
  assert.equal(delta.out__degradation, undefined);
});

test("llmNode: maxAttempts 缺省 1 = 不重试（抛错即降级）", async () => {
  let calls = 0;
  const provider: StageProvider = {
    callLLM: async () => {
      calls += 1;
      throw new Error("boom");
    },
  };
  const delta = await runNode(llmNode({ outputKey: "out", buildPrompt: () => "p" }), provider);
  assert.equal(calls, 1);
  assert.ok(delta.out__degradation !== undefined);
});

test("llmNode: timeoutMs 超时 → 降级且原因含超时（Promise.race 不阻塞）", async () => {
  const provider: StageProvider = {
    callLLM: async () => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return JSON.stringify({ foo: "a", bar: "b" });
    },
  };
  const delta = await runNode(
    llmNode({ outputKey: "out", maxAttempts: 1, timeoutMs: 30, schema: SCHEMA, buildPrompt: () => "p" }),
    provider,
  );
  assert.equal(delta.out, "");
  assert.ok((delta.out__degradation as { message: string }).message.includes("超时"));
});

test("llmNode: 无 provider → 降级（llm_unavailable），不调用 callLLM", async () => {
  const delta = await runNode(llmNode({ outputKey: "out", schema: SCHEMA, buildPrompt: () => "p" }), {});
  assert.equal(delta.out, "");
  assert.equal((delta.out__degradation as { reason: string }).reason, "llm_unavailable");
});

test("llmNode: 与图引擎协同（isDegraded/getDegradationMark 语义一致）", async () => {
  const provider: StageProvider = {
    callLLM: async () => {
      throw new Error("x");
    },
  };
  const delta = await runNode(llmNode({ outputKey: "out", maxAttempts: 2, buildPrompt: () => "p" }), provider);
  const state = { ...delta } as GraphState;
  assert.equal(isDegraded(state, "out"), true);
  assert.ok(getDegradationMark(state, "out") !== undefined);
});

test("llmNode: modelHint 透传 callLLM opts（P2-1 模型分层）", async () => {
  let received: unknown;
  const provider: StageProvider = {
    callLLM: async (_prompt, opts) => {
      received = opts?.modelHint;
      return "text";
    },
  };
  const delta = await runNode(llmNode({ outputKey: "out", modelHint: "cheap", buildPrompt: () => "p" }), provider);
  assert.equal(delta.out, "text");
  assert.equal(received, "cheap");
});

test("llmNode: 未配 modelHint 时不传（兼容旧 provider）", async () => {
  let received = "unset";
  const provider: StageProvider = {
    callLLM: async (_prompt, opts) => {
      received = opts?.modelHint ?? "unset";
      return "text";
    },
  };
  await runNode(llmNode({ outputKey: "out", buildPrompt: () => "p" }), provider);
  assert.equal(received, "unset");
});
