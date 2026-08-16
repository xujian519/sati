/**
 * always_on_* 工具 outputSchema 契约测试。
 *
 * 4 个 always-on 工具（always_on_discovery_plan / always_on_report /
 * always_on_prepare_workspace / always_on_read_chat_history）经
 * createLocalGateway → createBuiltinRegistry（requireOutputSchema: true）
 * 注册，缺 outputSchema 会使 server 启动 fail-loud。本 spec 验证：
 * 1) 各工具工厂产物均已声明 outputSchema；
 * 2) 典型成功 data 对各自 schema 零违约（契约有效）；
 * 3) 可注册到 requireOutputSchema: true 的注册表。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { validateCanonicalOutput } from "../../../src/tool/execution/outputSchemaValidation.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";
import { createAlwaysOnChatHistoryTool } from "../../../src/always-on/tool/AlwaysOnChatHistoryTool.js";
import { createAlwaysOnDiscoveryPlanTool } from "../../../src/always-on/tool/AlwaysOnDiscoveryPlanTool.js";
import { createAlwaysOnReportTool } from "../../../src/always-on/tool/AlwaysOnReportTool.js";
import { createAlwaysOnWorkspaceTool } from "../../../src/always-on/tool/AlwaysOnWorkspaceTool.js";

const TOOLS = [
  createAlwaysOnChatHistoryTool({ runContexts: {} as never }),
  createAlwaysOnDiscoveryPlanTool({ runContexts: {} as never }),
  createAlwaysOnReportTool({ runContexts: {} as never }),
  createAlwaysOnWorkspaceTool({ runContexts: {} as never }),
];

/** 各工具典型成功 data（与 execute 返回值中的 data 字段一致）。 */
const SAMPLE_DATA: Record<string, unknown> = {
  always_on_read_chat_history: {
    sessionId: "chat:project=/p:s_local",
    title: "会话标题",
    messageCount: 2,
    conversation: [
      { role: "user", text: "你好", createdAt: "" },
      { role: "assistant", text: "你好，有什么可以帮你？", createdAt: "" },
    ],
  },
  always_on_discovery_plan: {
    ok: true,
    planId: "plan_abc",
    planFilePath: "/p/.sati/always-on/plans/plan_abc.md",
    dedupeKey: "dedupe-1",
  },
  always_on_report: {
    ok: true,
    reportFilePath: "/p/.sati/always-on/reports/r1.md",
    fallbacks: [],
  },
  always_on_prepare_workspace: {
    ok: true,
    strategy: "git-worktree",
    cwd: "/p/.sati/worktrees/run-1",
    reused: false,
  },
};

test("4 个 always-on 工具均已声明 outputSchema", () => {
  for (const tool of TOOLS) {
    assert.ok(tool.outputSchema !== undefined, `工具 ${tool.name} 应声明 outputSchema`);
  }
});

test("典型成功 data 对各自 schema 零违约（契约有效）", () => {
  for (const tool of TOOLS) {
    const violations = validateCanonicalOutput(SAMPLE_DATA[tool.name], tool.outputSchema!);
    assert.deepEqual(violations, [], `${tool.name} 典型 data 应通过自身 schema（违约: ${violations.join("; ")}）`);
  }
});

test("可注册到 requireOutputSchema: true 的注册表", () => {
  const strict = new ToolRegistry({ requireOutputSchema: true });
  for (const tool of TOOLS) {
    assert.doesNotThrow(() => strict.register(tool), `${tool.name} 在强制注册表下应可注册`);
  }
});

test("schema 反向违约被检出（契约真的生效）", () => {
  const planTool = TOOLS.find(t => t.name === "always_on_discovery_plan")!;
  const missing = validateCanonicalOutput({ ok: true }, planTool.outputSchema!);
  assert.ok(missing.some(v => String(v).includes("planId: missing required")));
});
