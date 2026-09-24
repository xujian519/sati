import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PluginRuntime } from "../../src/extension/plugins/runtime/PluginRuntime.js";
import {
  HOOK_BUNDLE_MAX_BYTES,
  HookTrustStore,
  hookTrustKey,
  hookTrustStorePath,
  parseHookTrustFile,
} from "../../src/extension/plugins/trust/index.js";
import { createHookTrustService } from "../../src/cli/hookTrustService.js";
import { formatHookTrustList, runHookTrustCli } from "../../src/cli/commands/hookTrust.js";
import type { TelemetryClient, TelemetryFeatureUsedInput } from "../../src/telemetry/index.js";

/**
 * 协议 1.12 服务面 + `sati hooks` CLI：授权/撤销必须真的改变装载判定，
 * 且 `list` 要让人看见将被执行的内容（看不见内容的授权不是授权）。
 */

const COMMAND_HOOKS = { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] };

async function makeProject(): Promise<{ projectRoot: string; pilotHome: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-hooktrust-project-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-hooktrust-home-"));
  const pluginDir = join(projectRoot, ".sati", "plugins", "x");
  await mkdir(join(pluginDir, "hooks"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name: "x", version: "1.0.0" }), "utf8");
  await writeFile(join(pluginDir, "hooks", "hooks.json"), JSON.stringify(COMMAND_HOOKS), "utf8");
  return { projectRoot, pilotHome };
}

function serviceFor(projectRoot: string, pilotHome: string, telemetry?: TelemetryClient) {
  return createHookTrustService({
    resolveProject: () => ({ projectRoot, pluginRuntime: new PluginRuntime({ projectRoot, pilotHome }) }),
    store: new HookTrustStore(hookTrustStorePath(pilotHome)),
    ...(telemetry ? { telemetry } : {}),
  });
}

function capturingTelemetry(): { telemetry: TelemetryClient; calls: TelemetryFeatureUsedInput[] } {
  const calls: TelemetryFeatureUsedInput[] = [];
  const telemetry = {
    trackFeatureLoopStage: (input: TelemetryFeatureUsedInput) => void calls.push(input),
    trackError: () => {},
  } as unknown as TelemetryClient;
  return { telemetry, calls };
}

test("1.2b：list 列出声明原文与状态，decide grant 后转为 trusted", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  try {
    const service = serviceFor(projectRoot, pilotHome);
    const listed = await service.list({ projectKey: projectRoot });
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0]?.status, "pending");
    assert.match(listed.entries[0]?.pluginRoot ?? "", /sati-hooktrust-project-/u);
    assert.deepEqual(
      listed.entries[0]?.hooks.map(hook => [hook.event, hook.kind, hook.summary]),
      [["PreToolUse", "command", "echo hi"]],
    );

    const granted = await service.decide({ projectKey: projectRoot, pluginId: "x@project", verdict: "grant" });
    assert.equal(granted.applied, true);
    assert.equal(granted.entry?.status, "trusted");
    assert.equal((await service.list({ projectKey: projectRoot })).entries[0]?.status, "trusted");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：decide revoke 写撤销记录（状态 revoked，而非回到从未评审）", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  try {
    const service = serviceFor(projectRoot, pilotHome);
    await service.decide({ projectKey: projectRoot, pluginId: "x@project", verdict: "grant" });
    const revoked = await service.decide({ projectKey: projectRoot, pluginId: "x@project", verdict: "revoke" });
    assert.equal(revoked.applied, true);
    assert.equal(revoked.entry?.status, "revoked");
    const file = new HookTrustStore(hookTrustStorePath(pilotHome));
    const workspaceIdentityKey = (await service.list({ projectKey: projectRoot })).workspaceIdentityKey;
    assert.equal(file.read().entries[hookTrustKey(workspaceIdentityKey, "x@project")]?.decision, "revoked");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：decide 对未知插件与无法建立摘要的插件都不写记录", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  try {
    const service = serviceFor(projectRoot, pilotHome);
    const unknown = await service.decide({ projectKey: projectRoot, pluginId: "nope@project", verdict: "grant" });
    assert.deepEqual(unknown, { applied: false, reason: "unknown_plugin" });

    // 声明指向插件目录之外：摘要建立不了 ⇒ 授权无对象。
    const escapeDir = join(projectRoot, ".sati", "plugins", "escape");
    await mkdir(escapeDir, { recursive: true });
    await writeFile(
      join(escapeDir, "plugin.json"),
      JSON.stringify({ name: "escape", hooks: "../../outside.json" }),
      "utf8",
    );
    await writeFile(join(projectRoot, ".sati", "outside.json"), JSON.stringify(COMMAND_HOOKS), "utf8");
    const blocked = await service.decide({ projectKey: projectRoot, pluginId: "escape@project", verdict: "grant" });
    // 声明越界 = 内容无法被安全哈希 ⇒ 结构化原因 unsafe_content（#538），不再是笼统的 "blocked"。
    assert.deepEqual(blocked, { applied: false, reason: "blocked_unsafe_content" });
    const store = new HookTrustStore(hookTrustStorePath(pilotHome));
    assert.deepEqual(parseHookTrustFile(JSON.stringify({ version: 1, entries: {} })), store.read());
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：超出哈希上限的插件 → decide 拒为 blocked_over_limit，list 标 over_limit（#538）", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  try {
    // 一个声明了 hook 但目录超出字节上限的插件：摘要算不动 ⇒ 授权无对象。
    const bigDir = join(projectRoot, ".sati", "plugins", "big");
    await mkdir(join(bigDir, "hooks"), { recursive: true });
    await writeFile(join(bigDir, "plugin.json"), JSON.stringify({ name: "big", version: "1.0.0" }), "utf8");
    await writeFile(join(bigDir, "hooks", "hooks.json"), JSON.stringify(COMMAND_HOOKS), "utf8");
    await writeFile(join(bigDir, "asset.bin"), "x".repeat(HOOK_BUNDLE_MAX_BYTES + 1), "utf8");

    const service = serviceFor(projectRoot, pilotHome);
    const decided = await service.decide({ projectKey: projectRoot, pluginId: "big@project", verdict: "grant" });
    assert.deepEqual(decided, { applied: false, reason: "blocked_over_limit" });

    const listed = await service.list({ projectKey: projectRoot });
    const big = listed.entries.find(entry => entry.pluginId === "big@project");
    assert.equal(big?.status, "blocked");
    assert.equal(big?.blockedReason, "over_limit");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：CLI 子命令 list / approve / revoke 走通同一服务", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  const output: string[] = [];
  const write = (text: string) => void output.push(text);
  try {
    assert.equal(await runHookTrustCli({ argv: ["list"], projectRoot, pilotHome, write }), 0);
    assert.match(output.join(""), /x@project {2}\[pending\]/u);
    assert.match(output.join(""), /PreToolUse\[\*\] command: echo hi/u);
    assert.match(output.join(""), /sati hooks approve x@project/u);

    assert.equal(await runHookTrustCli({ argv: ["approve", "x@project"], projectRoot, pilotHome, write }), 0);
    assert.equal(output.at(-1)?.trim(), "approve x@project: applied (status=trusted)");

    output.length = 0;
    assert.equal(await runHookTrustCli({ argv: ["list", "--json"], projectRoot, pilotHome, write }), 0);
    const parsed = JSON.parse(output.join("")) as { entries: Array<{ status: string }> };
    assert.equal(parsed.entries[0]?.status, "trusted");

    assert.equal(await runHookTrustCli({ argv: ["revoke", "x@project"], projectRoot, pilotHome, write }), 0);
    assert.equal(output.at(-1)?.trim(), "revoke x@project: applied (status=revoked)");

    // 未知插件：非零退出码（脚本可据此判断）。
    assert.equal(await runHookTrustCli({ argv: ["approve", "nope@project"], projectRoot, pilotHome, write }), 1);
    assert.equal(output.at(-1)?.trim(), "approve nope@project: not applied (unknown_plugin)");
    // 未知子命令 / 缺参：打印用法并非零退出。
    assert.equal(await runHookTrustCli({ argv: ["bogus"], projectRoot, pilotHome, write }), 1);
    assert.equal(await runHookTrustCli({ argv: ["approve"], projectRoot, pilotHome, write }), 1);
    assert.equal(await runHookTrustCli({ argv: [], projectRoot, pilotHome, write }), 0);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：decide 上报决策遥测——撤销与授权失败必须区分开", async () => {
  const { projectRoot, pilotHome } = await makeProject();
  try {
    const { telemetry, calls } = capturingTelemetry();
    const service = serviceFor(projectRoot, pilotHome, telemetry);
    await service.decide({ projectKey: projectRoot, pluginId: "x@project", verdict: "grant" });
    await service.decide({ projectKey: projectRoot, pluginId: "x@project", verdict: "revoke" });
    await service.decide({ projectKey: projectRoot, pluginId: "nope@project", verdict: "grant" });

    assert.deepEqual(
      calls.map(call => [call.phase, call.loopStage, call.outcome, call.metadata?.verdict, call.metadata?.reason]),
      [
        ["hook_trust_decide", "module_event", "success", "grant", undefined],
        ["hook_trust_decide", "module_event", "success", "revoke", undefined],
        ["hook_trust_decide", "module_event", "denied", "grant", "unknown_plugin"],
      ],
    );
    assert.equal(calls[0]?.metadata?.status, "trusted");
    assert.equal(calls[1]?.metadata?.status, "revoked");
    // 插件 id 是声明内容，不上报。
    assert.equal(JSON.stringify(calls).includes("x@project"), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：无项目插件时 list 给出明确空态文案", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-hooktrust-empty-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-hooktrust-home-"));
  try {
    const service = serviceFor(projectRoot, pilotHome);
    const listed = await service.list({ projectKey: projectRoot });
    assert.deepEqual(listed.entries, []);
    assert.match(formatHookTrustList(listed), /No project plugins declare hooks/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});
