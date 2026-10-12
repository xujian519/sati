import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionRule, PermissionSettings } from "../../../src/permission/index.js";
import {
  buildSubmitOptions,
  buildSyntheticTurnMessages,
  normalizeGatewayModeForLegacyInput,
  normalizeGatewayRunMode,
  normalizePlanCommandInput,
  PLAN_COMMAND_USAGE,
  parsePlanCommand,
  planCommandUsageEvents,
  resolveSubmitTurnPermissions,
  sessionBusyEvents,
} from "../../../src/gateway/client/normalizers.js";
import type { GatewaySubmitTurnInput } from "../../../src/gateway/protocol/types.js";

test("normalizers: mode 归一化合法值透传、非法回退 default", () => {
  assert.equal(normalizeGatewayModeForLegacyInput("default"), "default");
  assert.equal(normalizeGatewayModeForLegacyInput("plan"), "plan");
  assert.equal(normalizeGatewayModeForLegacyInput("bypassPermissions"), "bypassPermissions");
  assert.equal(normalizeGatewayModeForLegacyInput("weird"), "default");
  assert.equal(normalizeGatewayModeForLegacyInput(undefined), undefined);
  assert.equal(normalizeGatewayModeForLegacyInput(""), undefined);
});

test("normalizers: runMode 归一化合法值透传、非法回退 agent", () => {
  assert.equal(normalizeGatewayRunMode("agent"), "agent");
  assert.equal(normalizeGatewayRunMode("plan"), "plan");
  assert.equal(normalizeGatewayRunMode("ask"), "ask");
  assert.equal(normalizeGatewayRunMode("whatever"), "agent");
  assert.equal(normalizeGatewayRunMode(undefined), undefined);
});

test("normalizers: parsePlanCommand 空 /plan 与带参数", () => {
  assert.deepEqual(parsePlanCommand("/plan"), { isPlanCommand: true, message: "" });
  assert.deepEqual(parsePlanCommand("/plan 设计一个功能"), { isPlanCommand: true, message: "设计一个功能" });
  assert.deepEqual(parsePlanCommand("普通消息"), { isPlanCommand: false, message: "普通消息" });
});

test("normalizers: normalizePlanCommandInput 改写为 plan 模式", () => {
  const input: GatewaySubmitTurnInput = { sessionKey: "s1", message: "/plan 设计功能", channelKey: "web" };
  const out = normalizePlanCommandInput(input);
  assert.ok(out);
  assert.equal(out.message, "设计功能");
  assert.equal(out.runMode, "plan");
  assert.equal(out.mode, "plan");
  assert.equal(out.allowPlanModeTools, true);
  assert.equal(out.basePermissionMode, "default");
});

test("normalizers: normalizePlanCommandInput 空 /plan 返回 undefined（引导用法）", () => {
  assert.equal(normalizePlanCommandInput({ sessionKey: "s1", message: "/plan", channelKey: "web" }), undefined);
  const plain = normalizePlanCommandInput({ sessionKey: "s1", message: "hello", channelKey: "web" });
  assert.ok(plain);
  assert.equal(plain.message, "hello");
});

test("normalizers: planCommandUsageEvents —— 顺序为「用法文本 → 正常收尾」", () => {
  const events = planCommandUsageEvents();
  assert.equal(events.length, 2);
  assert.deepEqual(
    events.map(e => e.type),
    ["assistant_text_delta", "turn_completed"],
    "调换顺序会改变客户端收流行为，必须钉住",
  );
  const delta = events[0];
  assert.ok(delta?.type === "assistant_text_delta");
  assert.equal(delta.text, PLAN_COMMAND_USAGE);
  const completed = events[1];
  assert.ok(completed?.type === "turn_completed");
  assert.equal(completed.finishReason, "completed");
});

test("normalizers: sessionBusyEvents —— status 与 error 同码同提示", () => {
  const events = sessionBusyEvents("s7");
  assert.deepEqual(
    events.map(e => e.type),
    ["agent_status", "error"],
  );
  const status = events[0];
  assert.ok(status?.type === "agent_status");
  assert.equal(status.event, "session_busy");
  const detail = status.detail;
  assert.ok(detail, "session_busy status 必须带 detail");
  assert.equal(detail["message"], "Session s7 already has an active turn.");
  assert.equal(detail["code"], "session_busy");
  assert.equal(detail["scope"], "session");
  const error = events[1];
  assert.ok(error?.type === "error");
  assert.equal(error.code, "session_busy");
  assert.equal(error.recoverable, true);
  assert.equal(error.message, detail["message"], "两处 event 必须携带同一条消息");
  assert.equal(error.userHint, detail["userHint"], "两处 event 必须携带同一条 userHint");
});

test("normalizers: buildSyntheticTurnMessages 加护栏抬头 + 默认 purpose", () => {
  assert.deepEqual(buildSyntheticTurnMessages(undefined), []);
  const out = buildSyntheticTurnMessages([{ text: "来自渠道的提示" }]);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.role, "user");
  assert.equal(out[0]!.metadata?.synthetic, true);
  assert.equal(out[0]!.metadata?.purpose, "channel_hint");
  const text = out[0]!.content[0] as { type: string; text: string };
  assert.equal(text.type, "text");
  assert.ok(text.text.includes("来自渠道的提示"));
  assert.notEqual(text.text, "来自渠道的提示", "渠道提示必须带非用户来源抬头");
});

const BASE_SETTINGS: PermissionSettings = {
  version: 1,
  allowedTools: ["read_file"],
  disallowedTools: [],
  skipPermissions: false,
};

const SESSION_GRANT: PermissionRule = { source: "session", behavior: "allow", toolName: "write_file" };

test("normalizers: resolveSubmitTurnPermissions —— plan 覆盖 runMode/allowPlanModeTools", () => {
  const out = resolveSubmitTurnPermissions(
    { sessionKey: "s1", channelKey: "web", message: "hi", mode: "plan" },
    BASE_SETTINGS,
    [],
  );
  assert.equal(out.runMode, "plan", "inputMode=plan 时 runMode 必须落到 plan");
  assert.equal(out.permissionMode, "plan");
  assert.equal(out.basePermissionMode, undefined);
  assert.equal(out.allowPlanModeTools, true, "plan 模式默认放开 plan-only 工具");
});

test("normalizers: resolveSubmitTurnPermissions —— skipPermissions 与 legacy runMode", () => {
  const bypass = resolveSubmitTurnPermissions(
    { sessionKey: "s1", channelKey: "web", message: "hi", runMode: "ask" },
    { ...BASE_SETTINGS, skipPermissions: true },
    [],
  );
  assert.equal(bypass.runMode, "ask", "显式 runMode 优先于 plan/agent 兜底");
  assert.equal(bypass.permissionMode, "bypassPermissions");
  assert.equal(bypass.allowPlanModeTools, false, "非 plan 模式默认不放 plan-only 工具");

  const strict = resolveSubmitTurnPermissions(
    { sessionKey: "s1", channelKey: "web", message: "hi" },
    BASE_SETTINGS,
    [],
  );
  assert.equal(strict.runMode, "agent", "无任何模式线索时兜底 agent");
  assert.equal(strict.permissionMode, undefined, "未跳过权限时不得自动升级为 bypassPermissions");
});

test("normalizers: resolveSubmitTurnPermissions —— 会话级授予与持久化规则合并（授予在前）", () => {
  const out = resolveSubmitTurnPermissions({ sessionKey: "s1", channelKey: "web", message: "hi" }, BASE_SETTINGS, [
    SESSION_GRANT,
  ]);
  assert.deepEqual(
    out.permissionRules.allow?.map(rule => rule.toolName),
    ["write_file", "read_file"],
    "会话级授予必须在持久化 allow 之前 —— 顺序即优先级",
  );
});

test("normalizers: buildSubmitOptions —— 空合成消息不产生 syntheticMessages 键", () => {
  const input: GatewaySubmitTurnInput = { sessionKey: "s1", channelKey: "web", message: "hi", maxTurns: 3 };
  const permissions = resolveSubmitTurnPermissions(input, BASE_SETTINGS, [SESSION_GRANT]);
  const options = buildSubmitOptions({
    input,
    permissions,
    runId: "run-9",
    allowedReadFiles: ["/tmp/a.png"],
    syntheticMessages: [],
  });
  assert.equal(options.turnId, "run-9");
  assert.equal(options.maxTurns, 3);
  assert.equal(options.permissionMode, permissions.permissionMode);
  assert.deepEqual(options.allowedReadFiles, ["/tmp/a.png"]);
  assert.deepEqual(options.permissionRules, permissions.permissionRules);
  assert.equal("syntheticMessages" in options, false, "空数组时不得透传（否则 transcript 会多出空数组）");

  const withHints = buildSubmitOptions({
    input,
    permissions,
    runId: "run-9",
    allowedReadFiles: [],
    syntheticMessages: buildSyntheticTurnMessages([{ text: "hint" }]),
  });
  assert.equal(withHints.syntheticMessages?.length, 1);
});
