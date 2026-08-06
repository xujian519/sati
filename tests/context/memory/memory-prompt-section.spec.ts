import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEdgeClawMemoryPromptSection } from "edgeclaw-memory-core";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import type { ContextPrepareInput } from "../../../src/context/protocol/types.js";
import type { CanonicalToolSchema } from "../../../src/model/protocol/canonical.js";

const ALL_MEMORY_TOOLS = [
  "memory_overview",
  "memory_list",
  "memory_search",
  "memory_get",
  "memory_flush",
  "memory_dream",
];

describe("buildEdgeClawMemoryPromptSection", () => {
  it("availableTools 不含任何 memory_* 工具时返回 null", () => {
    assert.equal(buildEdgeClawMemoryPromptSection({ availableTools: ["read_file", "bash"] }), null);
    assert.equal(buildEdgeClawMemoryPromptSection({ availableTools: [] }), null);
    assert.equal(buildEdgeClawMemoryPromptSection(), null);
  });

  it("availableTools 含全部 memory_* 工具时输出完整 ClawXMemory 段落", () => {
    const section = buildEdgeClawMemoryPromptSection({ availableTools: ALL_MEMORY_TOOLS });

    assert.ok(section !== null);
    assert.match(section, /^## ClawXMemory\n/);
    assert.match(section, /memory_overview/);
    assert.match(section, /memory_list/);
    assert.match(section, /memory_search/);
    assert.match(section, /memory_get/);
    assert.match(section, /memory_flush/);
    assert.match(section, /memory_dream/);
  });

  it("仅注册部分工具时只出现对应指引", () => {
    const section = buildEdgeClawMemoryPromptSection({ availableTools: ["memory_overview"] });

    assert.ok(section !== null);
    assert.match(section, /## ClawXMemory/);
    assert.match(section, /Use memory_overview/);
    assert.doesNotMatch(section, /Use memory_list/);
    assert.doesNotMatch(section, /memory_flush/);
  });
});

describe("DefaultContextRuntime.prepareForModel 接入 ClawXMemory 段落", () => {
  function makeInput(tools: CanonicalToolSchema[]): ContextPrepareInput {
    return {
      sessionId: "s1",
      turnId: "t1",
      cwd: process.cwd(),
      provider: "test",
      model: "test-model",
      permissionMode: "bypassPermissions",
      additionalWorkingDirectories: [],
      messages: [{ role: "user", content: [{ type: "text", text: "你好" }] }],
      tools,
    };
  }

  it("tools 含 memory_* 时 systemPrompt 含 ## ClawXMemory，不含则无段落", async () => {
    const runtime = new DefaultContextRuntime();

    const withMemory = await runtime.prepareForModel(
      makeInput(ALL_MEMORY_TOOLS.map(name => ({ name, inputSchema: { type: "object" } }))),
    );
    assert.match(withMemory.systemPrompt ?? "", /## ClawXMemory/);
    assert.ok(withMemory.systemPromptParts.some(part => part.startsWith("## ClawXMemory")));

    const withoutMemory = await runtime.prepareForModel(
      makeInput([{ name: "read_file", inputSchema: { type: "object" } }]),
    );
    assert.doesNotMatch(withoutMemory.systemPrompt ?? "", /## ClawXMemory/);
  });
});
