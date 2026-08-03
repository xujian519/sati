import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalMessage } from "../../../src/model/protocol/canonical.js";
import type { RouterDecisionInput } from "../../../src/router/protocol/decision.js";
import { decideScenario } from "../../../src/router/scenario/decideScenario.js";

function textMessage(role: "user" | "assistant", text: string): CanonicalMessage {
  return { role, content: [{ type: "text", text }] };
}

function makeInput(overrides: Partial<RouterDecisionInput> = {}): RouterDecisionInput {
  return {
    request: {
      // decideScenario 仅读取 request.messages / request.tools；其余字段用宽松类型占位。
      messages: [textMessage("user", "hello")],
      tools: [],
    } as unknown as RouterDecisionInput["request"],
    sessionId: "s1",
    isMainAgent: true,
    ...overrides,
  };
}

describe("decideScenario", () => {
  it("显式 provider + model 时返回 explicit 场景", () => {
    const result = decideScenario(
      makeInput({ metadata: { explicitProvider: "anthropic", explicitModel: "claude-sonnet-4" } }),
    );
    assert.equal(result.scenarioType, "explicit");
    assert.deepEqual(result.selection, {
      id: "anthropic/claude-sonnet-4",
      provider: "anthropic",
      model: "claude-sonnet-4",
    });
    assert.equal(result.isSubagent, false);
  });

  it("仅显式 provider 缺少 model 时不视为 explicit", () => {
    const result = decideScenario(makeInput({ metadata: { explicitProvider: "anthropic" } }));
    assert.notEqual(result.scenarioType, "explicit");
    assert.equal(result.selection, undefined);
  });

  it("用户消息含 subagent 标签时返回 subagent 场景与 modelHint", () => {
    const request = {
      messages: [textMessage("user", "<sati-subagent-model>claude-opus-4</sati-subagent-model> do the work")],
      tools: [{ name: "bash", inputSchema: {} }],
    } as unknown as RouterDecisionInput["request"];
    const result = decideScenario(makeInput({ request }));
    assert.equal(result.scenarioType, "subagent");
    assert.equal(result.isSubagent, true);
    assert.equal(result.subagentModelHint, "claude-opus-4");
  });

  it("非主 agent（isMainAgent=false）归入 default 且标记为 subagent", () => {
    const result = decideScenario(makeInput({ isMainAgent: false }));
    assert.equal(result.scenarioType, "default");
    assert.equal(result.isSubagent, true);
  });

  it("default 场景使用 scenarios.default 作为选择", () => {
    const result = decideScenario(makeInput(), {
      default: { id: "google/gemini-3-flash", provider: "google", model: "gemini-3-flash" },
    });
    assert.equal(result.scenarioType, "default");
    assert.deepEqual(result.selection, { id: "google/gemini-3-flash", provider: "google", model: "gemini-3-flash" });
  });

  it("default 场景无 scenarios 配置时 selection 为空", () => {
    const result = decideScenario(makeInput());
    assert.equal(result.scenarioType, "default");
    assert.equal(result.selection, undefined);
  });
});
