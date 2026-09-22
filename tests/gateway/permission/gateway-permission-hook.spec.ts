import assert from "node:assert/strict";
import test from "node:test";
import { createGatewayPermissionHook } from "../../../src/gateway/permission/createGatewayPermissionHook.js";
import { GatewayPermissionBus } from "../../../src/gateway/permission/GatewayPermissionBus.js";
import type { GatewayEvent } from "../../../src/gateway/protocol/types.js";
import type { PermissionRule } from "../../../src/permission/protocol/types.js";

/**
 * 网关权限 hook 行为基线（刷新：此前 `createGatewayPermissionHook` /
 * `GatewayPermissionBus` 在 tests/ 下零引用）。
 *
 * 重点是子代理 fork 的归属：子代理共享父级的 hook 与 sessionKey，请求会落进
 * 父界面；帧里必须带 `origin`，否则 UI 只看到一个工具名，分不清是谁在请求。
 */

function makeHook(options: { delivered?: boolean; permissionRules?: PermissionRule[] } = {}) {
  const emitted: GatewayEvent[] = [];
  const permissionRules = options.permissionRules ?? [];
  let sequence = 0;
  const hook = createGatewayPermissionHook({
    sessionKey: "session-key",
    bus: new GatewayPermissionBus(),
    emit: event => {
      emitted.push(event);
      return options.delivered ?? true;
    },
    permissionRules,
    uuid: () => `req-${++sequence}`,
  });
  return { hook, emitted, permissionRules };
}

function permissionCall(extra: Record<string, unknown> = {}) {
  return {
    hookInput: {
      hookEventName: "PermissionRequest" as const,
      sessionId: "session-key",
      transcriptPath: "",
      cwd: "/proj",
      toolName: "write_file",
      toolUseId: "call-1",
      toolInput: { filePath: "a.md" },
      ...extra,
    },
  };
}

function firstRequest(emitted: GatewayEvent[]): Extract<GatewayEvent, { type: "permission_request" }> {
  const event = emitted.find(candidate => candidate.type === "permission_request");
  assert.ok(event, "必须发出 permission_request 帧");
  return event;
}

test("主代理自身的请求不带 origin", async () => {
  const { hook, emitted } = makeHook();
  void hook(permissionCall());
  const event = firstRequest(emitted);
  assert.equal(event.requestId, "req-1");
  assert.equal(event.toolName, "write_file");
  assert.deepEqual(event.payload, { filePath: "a.md" });
  assert.equal("origin" in event, false, "主代理请求不得被标成子代理来源");
});

test("子代理 fork 内的请求带 origin（含 fork 类型）", async () => {
  const { hook, emitted } = makeHook();
  void hook(
    permissionCall({
      sessionId: "/proj::sub::fork-1",
      agentId: "fork-1",
      agentType: "general-purpose",
    }),
  );
  assert.deepEqual(firstRequest(emitted).origin, {
    kind: "subagent",
    subagentId: "fork-1",
    subagentType: "general-purpose",
  });
});

test("origin 里的 subagentId 去空白，缺 agentType 时省略该字段", async () => {
  const { hook, emitted } = makeHook();
  void hook(permissionCall({ agentId: "  fork-2  " }));
  assert.deepEqual(firstRequest(emitted).origin, { kind: "subagent", subagentId: "fork-2" });
});

test("空 agentId 不产生 origin（畸形 hook 输入不得渲染成「来自子代理 undefined」）", async () => {
  const { hook, emitted } = makeHook();
  void hook(permissionCall({ agentId: "   " }));
  assert.equal("origin" in firstRequest(emitted), false);
});

test("无活跃 submit-turn sink 时立即 deny（不挂起、不注册 pending）", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-key",
    bus,
    emit: () => false,
    permissionRules: [],
  });

  const output = await hook(permissionCall());
  assert.equal((output as { specific?: { decision?: { behavior?: string } } }).specific?.decision?.behavior, "deny");
  assert.equal(bus.pendingCount("session-key"), 0);
});

test("允许并记住：往返后返回 allow，并把会话级 allow 规则推进共享数组", async () => {
  const bus = new GatewayPermissionBus();
  const permissionRules: PermissionRule[] = [];
  const hook = createGatewayPermissionHook({
    sessionKey: "session-key",
    bus,
    emit: () => true,
    permissionRules,
    uuid: () => "req-allow",
  });

  const pending = hook(permissionCall({ permissionSuggestions: [{ id: "allow_session" }] }));
  const registration = bus.consume("session-key", "req-allow");
  assert.ok(registration, "hook 必须把待决请求挂到会话桶上（UI 才能按 requestId 放行）");
  assert.equal(registration.toolName, "write_file");
  assert.equal(registration.toolCallId, "call-1");
  registration.resolve({ requestId: "req-allow", decision: "allow", remember: true });

  const output = await pending;
  assert.equal((output as { specific?: { decision?: { behavior?: string } } }).specific?.decision?.behavior, "allow");
  assert.deepEqual(permissionRules, [{ source: "session", behavior: "allow", toolName: "write_file" }]);
});

test("拒绝：往返后返回 deny，并带上用户给的理由", async () => {
  const bus = new GatewayPermissionBus();
  const hook = createGatewayPermissionHook({
    sessionKey: "session-key",
    bus,
    emit: () => true,
    permissionRules: [],
    uuid: () => "req-deny",
  });

  const pending = hook(permissionCall());
  bus
    .consume("session-key", "req-deny")!
    .resolve({ requestId: "req-deny", decision: "deny", reason: "不要写这个文件" });

  const output = (await pending) as { specific?: { decision?: { behavior?: string; message?: string } } };
  assert.equal(output.specific?.decision?.behavior, "deny");
  assert.equal(output.specific?.decision?.message, "不要写这个文件");
});
