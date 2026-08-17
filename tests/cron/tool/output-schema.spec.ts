/**
 * cron_* 工具 outputSchema 契约测试。
 *
 * 4 个 cron 工具（cron_create / cron_list / cron_delete / cron_stop）经
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
import type { CronToolRuntime } from "../../../src/cron/tool/CronToolRuntime.js";
import { createCronCreateTool } from "../../../src/cron/tool/CronCreateTool.js";
import { createCronDeleteTool } from "../../../src/cron/tool/CronDeleteTool.js";
import { createCronListTool } from "../../../src/cron/tool/CronListTool.js";
import { createCronStopTool } from "../../../src/cron/tool/CronStopTool.js";

const TOOLS = [
  createCronCreateTool({} as unknown as CronToolRuntime),
  createCronListTool({} as unknown as CronToolRuntime),
  createCronDeleteTool({} as unknown as CronToolRuntime),
  createCronStopTool({} as unknown as CronToolRuntime),
];

/** 各工具典型成功 data（与 execute 返回值中的 data 字段一致）。 */
const TASK_SAMPLE = {
  schemaVersion: 1,
  taskId: "task-1",
  message: "提醒我喝水",
  schedule: { type: "once", runAt: "2026-08-16T12:00:00.000Z" },
  status: "scheduled",
  sessionKey: "chat:project=/p:s_local",
  channelKey: "tui",
  createdAt: "2026-08-16T00:00:00.000Z",
  updatedAt: "2026-08-16T00:00:00.000Z",
};

const SAMPLE_DATA: Record<string, unknown> = {
  cron_create: { task: TASK_SAMPLE },
  cron_list: { tasks: [TASK_SAMPLE] },
  cron_delete: { deleted: true, stoppedRunId: "run-1" },
  cron_stop: { stopped: true, taskId: "task-1" },
};

test("4 个 cron 工具均已声明 outputSchema", () => {
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
  const deleteTool = TOOLS.find(t => t.name === "cron_delete")!;
  const missing = validateCanonicalOutput({}, deleteTool.outputSchema!);
  assert.ok(missing.some(v => String(v).includes("deleted: missing required")));
});
