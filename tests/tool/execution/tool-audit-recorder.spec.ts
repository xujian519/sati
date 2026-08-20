/**
 * ToolRuntime 审计记录非阻塞投递测试（批 6）。
 *
 * recordPermission/recordTool 类型均为 `void | Promise<void>`，实现可选
 * （仓库当前无注入实现）。约束：审计是旁路记录，不得串行阻塞工具执行
 * 路径——同步实现立即执行、异步实现 fire-and-forget（拒绝吞掉）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PermissionRuntime } from "../../../src/permission/index.js";
import type {
  SatiToolAuditRecorder,
  SatiPermissionAuditRecord,
  SatiToolAuditRecord,
} from "../../../src/tool/audit/ToolAuditRecorder.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../../../src/tool/protocol/types.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

function context(auditRecorder?: SatiToolAuditRecorder): SatiToolRuntimeContext {
  return {
    sessionId: "s1",
    turnId: "t1",
    cwd: process.cwd(),
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd: process.cwd(),
      additionalWorkingDirectories: [],
      canPrompt: true,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    now: () => new Date("2026-08-20T00:00:00.000Z"),
    ...(auditRecorder ? { auditRecorder } : {}),
  };
}

const echoTool: SatiToolDefinition = {
  name: "audit_echo_tool",
  description: "returns input text",
  kind: "custom",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
};

function createRuntime(): ToolRuntime {
  const registry = new ToolRegistry();
  registry.register(echoTool);
  return new ToolRuntime(registry, new PermissionRuntime());
}

/** 收集型 recorder：同步实现，记录全部调用。 */
function collectingRecorder(): {
  recorder: SatiToolAuditRecorder;
  permissions: SatiPermissionAuditRecord[];
  tools: SatiToolAuditRecord[];
} {
  const permissions: SatiPermissionAuditRecord[] = [];
  const tools: SatiToolAuditRecord[] = [];
  return {
    recorder: {
      recordPermission(record) {
        permissions.push(record);
      },
      recordTool(record) {
        tools.push(record);
      },
    },
    permissions,
    tools,
  };
}

test("无 auditRecorder 时工具执行正常（既有行为不回归）", async () => {
  const result = await createRuntime().execute({ id: "c1", name: "audit_echo_tool", input: {} }, context());
  assert.equal(result.type, "success");
});

test("同步审计实现立即执行：recordPermission/recordTool 均在结果返回前完成", async () => {
  const { recorder, permissions, tools } = collectingRecorder();
  const result = await createRuntime().execute({ id: "c1", name: "audit_echo_tool", input: {} }, context(recorder));
  assert.equal(result.type, "success");
  // 同步实现：execute resolve 时审计必然已记录（若串行 await 慢实现则此处不等）。
  assert.equal(permissions.length, 1, "recordPermission 应被调用一次");
  assert.equal(tools.length, 1, "recordTool 应被调用一次");
  assert.equal(permissions[0]?.decision, "allow");
  assert.equal(permissions[0]?.toolName, "audit_echo_tool");
  assert.equal(tools[0]?.status, "success");
  assert.equal(tools[0]?.toolName, "audit_echo_tool");
  assert.equal(typeof tools[0]?.durationMs, "number");
});

test("异步 rejected 审计实现不阻塞执行、不向外抛错", async () => {
  const recorder: SatiToolAuditRecorder = {
    recordPermission: () => Promise.reject(new Error("audit write failed")),
    recordTool: () => Promise.reject(new Error("audit write failed")),
  };
  const result = await createRuntime().execute({ id: "c1", name: "audit_echo_tool", input: {} }, context(recorder));
  assert.equal(result.type, "success", "审计失败不得影响工具结果");
});

test("失败路径同样非阻塞记录 recordTool（status=error）", async () => {
  const { recorder, tools } = collectingRecorder();
  const registry = new ToolRegistry();
  registry.register({
    name: "audit_boom_tool",
    description: "always throws",
    kind: "custom",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    execute: async () => {
      throw new Error("boom");
    },
  });
  const runtime = new ToolRuntime(registry, new PermissionRuntime());
  const result = await runtime.execute({ id: "c2", name: "audit_boom_tool", input: {} }, context(recorder));
  assert.equal(result.type, "error");
  assert.equal(tools.length, 1, "失败路径也应记录审计");
  assert.equal(tools[0]?.status, "error");
  assert.equal(tools[0]?.toolName, "audit_boom_tool");
});
