import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPluginHooks } from "../../../src/extension/plugins/loading/PluginHookLoader.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import {
  computeHookBundleDigest,
  computeWorkspaceIdentityKey,
  evaluateProjectHookTrust,
  HOOK_BUNDLE_MAX_BYTES,
  HOOK_TRUST_STORE_VERSION,
  HookTrustReporter,
  HookTrustStore,
  hookTrustKey,
  hookTrustStorePath,
  parseHookTrustFile,
  type HookTrustEntry,
  type HookTrustFile,
} from "../../../src/extension/plugins/trust/index.js";
import type { Logger } from "../../../src/telemetry/index.js";

/**
 * 1.2a 报告期：项目级 hook 的信任评估与上报。
 *
 * 关键断言是「只报告、不改变行为」——项目来源的 hook 在 1.2a 仍全部装载执行，
 * 评估只产出状态；未信任即不装载属于 1.2b。
 */

const COMMAND_HOOKS = { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] };

async function writeProjectPlugin(projectRoot: string, name: string, hooks: unknown): Promise<string> {
  const pluginDir = join(projectRoot, ".sati", "plugins", name);
  await mkdir(join(pluginDir, "hooks"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }), "utf8");
  await writeFile(join(pluginDir, "hooks", "hooks.json"), JSON.stringify(hooks), "utf8");
  return pluginDir;
}

async function projectPlugins(projectRoot: string, pilotHome: string) {
  const runtime = new PluginRuntime({ projectRoot, pilotHome });
  await runtime.refresh();
  return runtime.snapshot();
}

function emptyTrustFile(): HookTrustFile {
  return { version: HOOK_TRUST_STORE_VERSION, entries: {} };
}

async function digestOf(pluginDir: string): Promise<string> {
  const bundle = await computeHookBundleDigest(pluginDir, { name: "x" });
  if (bundle.kind !== "hashed") throw new Error(`expected a hashed bundle, got: ${bundle.detail}`);
  return bundle.digest;
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const push = (prefix: string) => (message: string) => void lines.push(`${prefix}: ${message}`);
  return { logger: { info: push("info"), warn: push("warn"), error: push("error"), debug: push("debug") }, lines };
}

test("1.2a：摘要跟内容走而非 mtime——改写声明变摘要，仅改 mtime 不变", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-hash-"));
  try {
    const pluginDir = await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const hooksPath = join(pluginDir, "hooks", "hooks.json");
    const before = await digestOf(pluginDir);

    // 仅改 mtime（`touch` / checkout / rsync 的形态）：内容未变 → 摘要不变。
    const bumped = new Date(Date.now() + 60_000);
    await utimes(hooksPath, bumped, bumped);
    assert.equal(await digestOf(pluginDir), before);

    await writeFile(
      hooksPath,
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "curl evil" }] }] }),
    );
    assert.notEqual(await digestOf(pluginDir), before);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("1.2a：项目插件声明 hook → 状态 pending（从未评审）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-pending-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const plugins = await projectPlugins(projectRoot, pilotHome);
    const evaluation = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey: await computeWorkspaceIdentityKey(projectRoot),
      trustFile: emptyTrustFile(),
    });
    assert.equal(evaluation.entries.length, 1);
    const entry = evaluation.entries[0] as HookTrustEntry;
    assert.equal(entry.pluginId, "x@project");
    assert.equal(entry.status, "pending");
    assert.match(entry.digest ?? "", /^sha256:[0-9a-f]{64}$/u);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：拍平后的 matcher 带 source，且项目 hook 仍全部装载（行为不变）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-source-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const plugins = await projectPlugins(projectRoot, pilotHome);
    const settings = loadPluginHooks(plugins);
    assert.equal(settings.PreToolUse?.length, 1);
    assert.equal(settings.PreToolUse?.[0]?.source, "project");
    assert.equal(settings.PreToolUse?.[0]?.pluginId, "x@project");
    assert.equal(settings.PreToolUse?.[0]?.hooks.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：摘要一致 → trusted；摘要不同 → stale；撤销优先于摘要一致", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-status-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    const pluginDir = await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const plugins = await projectPlugins(projectRoot, pilotHome);
    const workspaceIdentityKey = await computeWorkspaceIdentityKey(projectRoot);
    const key = hookTrustKey(workspaceIdentityKey, "x@project");
    const record = {
      pluginId: "x@project",
      decision: "granted" as const,
      digest: await digestOf(pluginDir),
      grantedAt: "2026-09-21T00:00:00.000Z",
      sourcePath: pluginDir,
    };

    const trusted = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey,
      trustFile: { version: HOOK_TRUST_STORE_VERSION, entries: { [key]: record } },
    });
    assert.equal(trusted.entries[0]?.status, "trusted");

    const stale = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey,
      trustFile: {
        version: HOOK_TRUST_STORE_VERSION,
        entries: { [key]: { ...record, digest: "sha256:0000" } },
      },
    });
    assert.equal(stale.entries[0]?.status, "stale");

    const revoked = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey,
      trustFile: {
        version: HOOK_TRUST_STORE_VERSION,
        entries: { [key]: { ...record, decision: "revoked" } },
      },
    });
    assert.equal(revoked.entries[0]?.status, "revoked");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：授权按工作区隔离（换一个工作区身份 → 回到 pending）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-scope-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    const pluginDir = await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const plugins = await projectPlugins(projectRoot, pilotHome);
    const workspaceIdentityKey = await computeWorkspaceIdentityKey(projectRoot);
    const digest = await digestOf(pluginDir);
    const otherWorkspaceKey = await computeWorkspaceIdentityKey(join(projectRoot, "elsewhere"));
    const evaluation = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey: otherWorkspaceKey,
      trustFile: {
        version: HOOK_TRUST_STORE_VERSION,
        entries: {
          [hookTrustKey(workspaceIdentityKey, "x@project")]: {
            pluginId: "x@project",
            decision: "granted",
            digest,
            grantedAt: "2026-09-21T00:00:00.000Z",
            sourcePath: pluginDir,
          },
        },
      },
    });
    assert.equal(evaluation.entries[0]?.status, "pending");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：非项目来源与未声明 hook 的插件不进入评估面", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-filter-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    await writeProjectPlugin(projectRoot, "with-hooks", COMMAND_HOOKS);
    await writeProjectPlugin(projectRoot, "without-hooks", {});
    const plugins = await projectPlugins(projectRoot, pilotHome);
    const evaluation = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey: await computeWorkspaceIdentityKey(projectRoot),
      trustFile: emptyTrustFile(),
    });
    assert.deepEqual(
      evaluation.entries.map(entry => entry.pluginId),
      ["with-hooks@project"],
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：无法建立摘要的形态一律 blocked（声明越界 / 符号链接 / 超出上限）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-trust-blocked-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    const pluginDir = await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);

    const escape = await computeHookBundleDigest(pluginDir, { name: "x", hooks: "../../outside.json" });
    assert.equal(escape.kind, "blocked");

    const linkedDir = await writeProjectPlugin(projectRoot, "linked", COMMAND_HOOKS);
    await symlink(join(projectRoot, "target"), join(linkedDir, "escape"));
    const linked = await computeHookBundleDigest(linkedDir, { name: "linked" });
    assert.equal(linked.kind, "blocked");

    const bigDir = await writeProjectPlugin(projectRoot, "big", COMMAND_HOOKS);
    await writeFile(join(bigDir, "asset.bin"), "x".repeat(HOOK_BUNDLE_MAX_BYTES + 1), "utf8");
    const big = await computeHookBundleDigest(bigDir, { name: "big" });
    assert.equal(big.kind, "blocked");

    const plugins = await projectPlugins(projectRoot, pilotHome);
    const evaluation = await evaluateProjectHookTrust({
      plugins,
      workspaceIdentityKey: await computeWorkspaceIdentityKey(projectRoot),
      trustFile: emptyTrustFile(),
    });
    const statuses = Object.fromEntries(evaluation.entries.map(entry => [entry.pluginId, entry.status]));
    assert.equal(statuses["x@project"], "pending");
    assert.equal(statuses["linked@project"], "blocked");
    assert.equal(statuses["big@project"], "blocked");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：信任存储损坏/版本未知/条目畸形 → 空表（fail-closed）", () => {
  const validRecord = {
    pluginId: "x@project",
    decision: "granted",
    digest: "sha256:ab",
    grantedAt: "2026-09-21T00:00:00.000Z",
    sourcePath: "/p",
  };
  assert.deepEqual(parseHookTrustFile("{ not json"), emptyTrustFile());
  // 版本门必须真的挡住：记录本身合法，只因版本未知就不得被采信。
  assert.deepEqual(parseHookTrustFile(JSON.stringify({ version: 99, entries: { a: validRecord } })), emptyTrustFile());
  assert.deepEqual(parseHookTrustFile(JSON.stringify({ version: 1, entries: [] })), emptyTrustFile());
  const mixed = parseHookTrustFile(
    JSON.stringify({
      version: 1,
      entries: {
        good: validRecord,
        badDecision: { ...validRecord, decision: "maybe" },
      },
    }),
  );
  assert.deepEqual(Object.keys(mixed.entries), ["good"]);
});

test("1.2a：存储文件缺失时读取为空表（不抛错）", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-trust-home-"));
  try {
    const store = new HookTrustStore(hookTrustStorePath(pilotHome));
    assert.deepEqual(store.read(), emptyTrustFile());
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2a：报告按工作区去重——内容不变不重复输出，状态变化再输出一次", () => {
  const { logger, lines } = capturingLogger();
  const reporter = new HookTrustReporter(logger);
  const entry: HookTrustEntry = {
    pluginId: "x@project",
    pluginName: "x",
    source: "project",
    status: "pending",
    digest: "sha256:ab",
  };
  assert.equal(reporter.report({ workspaceIdentityKey: "ws1", entries: [entry] }), true);
  assert.equal(reporter.report({ workspaceIdentityKey: "ws1", entries: [entry] }), false);
  assert.equal(reporter.report({ workspaceIdentityKey: "ws2", entries: [entry] }), true);
  assert.equal(reporter.report({ workspaceIdentityKey: "ws2", entries: [{ ...entry, status: "trusted" }] }), true);
  assert.equal(reporter.report({ workspaceIdentityKey: "ws3", entries: [] }), false);
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /^warn: Hook trust: workspace=ws1 projectPlugins=1 disabled=1 /u);
  assert.match(lines[2] ?? "", /^info: Hook trust: workspace=ws2 /u);
});

test("1.2a：工作区身份键为 32 位 hex 摘要，且路径不同则键不同", async () => {
  const a = await computeWorkspaceIdentityKey("/tmp/sati-identity-a");
  const b = await computeWorkspaceIdentityKey("/tmp/sati-identity-b");
  assert.match(a, /^[0-9a-f]{32}$/u);
  assert.notEqual(a, b);
  assert.equal(a, await computeWorkspaceIdentityKey("/tmp/sati-identity-a"));
});
