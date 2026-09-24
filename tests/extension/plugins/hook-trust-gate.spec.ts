import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadPluginHooks } from "../../../src/extension/plugins/loading/PluginHookLoader.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import {
  computeHookBundleDigest,
  computeWorkspaceIdentityKey,
  evaluateProjectHookTrust,
  HOOK_TRUST_STORE_VERSION,
  HookTrustStore,
  hookTrustKey,
  hookTrustStorePath,
  parseHookTrustFile,
  retainTrustedHookMatchers,
  summarizeHookDeclarations,
  type HookTrustEvaluation,
} from "../../../src/extension/plugins/trust/index.js";
import type { SatiHooksSettings } from "../../../src/extension/hooks/protocol/settings.js";
import type { SatiLoadedPlugin } from "../../../src/extension/plugins/protocol/plugin.js";

/**
 * 1.2b 强制期：未评审的项目 hook 不进入 HookRuntime；授权以内容摘要为准。
 *
 * 本文件钉三件事：(1) 过滤只针对 `project` 来源且只在 `trusted` 时放行；
 * (2) 存储写路径往返 + 版本门；(3) 声明投影（人看到的就是将被执行的东西）。
 */

const COMMAND_HOOKS = { PreToolUse: [{ hooks: [{ type: "command", command: "echo hi" }] }] };

async function writeProjectPlugin(projectRoot: string, name: string, hooks: unknown): Promise<string> {
  const pluginDir = join(projectRoot, ".sati", "plugins", name);
  await mkdir(join(pluginDir, "hooks"), { recursive: true });
  await writeFile(join(pluginDir, "plugin.json"), JSON.stringify({ name, version: "1.0.0" }), "utf8");
  await writeFile(join(pluginDir, "hooks", "hooks.json"), JSON.stringify(hooks), "utf8");
  return pluginDir;
}

function matcher(pluginId: string, source: "builtin" | "global" | "project", command: string) {
  return {
    hooks: [{ type: "command" as const, command }],
    pluginId,
    pluginName: pluginId.split("@")[0] ?? pluginId,
    source,
  };
}

function evaluation(entries: HookTrustEvaluation["entries"]): HookTrustEvaluation {
  return { workspaceIdentityKey: "ws", entries };
}

test("1.2b：过滤只放行 trusted 的 project matcher，其余来源原样保留", () => {
  const settings: SatiHooksSettings = {
    PreToolUse: [
      matcher("a@project", "project", "echo a"),
      matcher("b@project", "project", "echo b"),
      matcher("c@global", "global", "echo c"),
      { hooks: [{ type: "callback" as const, name: "gateway_permission" }] },
    ],
  };
  const entries = [
    { pluginId: "a@project", pluginName: "a", source: "project" as const, status: "trusted" as const },
    { pluginId: "b@project", pluginName: "b", source: "project" as const, status: "pending" as const },
  ];
  const retained = retainTrustedHookMatchers(settings, evaluation(entries));
  assert.deepEqual(
    retained.PreToolUse?.map(item => item.pluginId ?? "host-callback"),
    ["a@project", "c@global", "host-callback"],
  );
});

test("1.2b：stale / revoked / blocked 与缺 pluginId 的 project matcher 一律剔除", () => {
  const settings: SatiHooksSettings = {
    PreToolUse: [
      matcher("stale@project", "project", "echo 1"),
      matcher("revoked@project", "project", "echo 2"),
      matcher("blocked@project", "project", "echo 3"),
      { hooks: [{ type: "command" as const, command: "echo 4" }], source: "project" as const },
    ],
  };
  const entries = [
    { pluginId: "stale@project", pluginName: "stale", source: "project" as const, status: "stale" as const },
    { pluginId: "revoked@project", pluginName: "revoked", source: "project" as const, status: "revoked" as const },
    { pluginId: "blocked@project", pluginName: "blocked", source: "project" as const, status: "blocked" as const },
  ];
  assert.deepEqual(retainTrustedHookMatchers(settings, evaluation(entries)), {});
});

test("1.2b：空评估（评估失败时的 fail-closed 入参）会清掉全部 project matcher", () => {
  const settings: SatiHooksSettings = {
    PreToolUse: [matcher("a@project", "project", "echo a"), matcher("g@global", "global", "echo g")],
  };
  const retained = retainTrustedHookMatchers(settings, evaluation([]));
  assert.deepEqual(
    retained.PreToolUse?.map(item => item.pluginId),
    ["g@global"],
  );
});

test("1.2b：真实装配链上「未授权 → 不装载；授权 → 装载」", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-gate-e2e-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-gate-home-"));
  try {
    await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    await runtime.refresh();
    const plugins = runtime.snapshotContributions().plugins;
    const settings = loadPluginHooks(plugins);
    assert.equal(settings.PreToolUse?.length, 1);

    const workspaceIdentityKey = await computeWorkspaceIdentityKey(projectRoot);
    const store = new HookTrustStore(hookTrustStorePath(pilotHome));

    const before = await evaluateProjectHookTrust({ plugins, workspaceIdentityKey, trustFile: store.read() });
    assert.deepEqual(retainTrustedHookMatchers(settings, before), {});

    const bundle = await computeHookBundleDigest(
      plugins[0]?.path ?? "",
      (plugins[0]?.manifest ?? { name: "x" }) as SatiLoadedPlugin["manifest"],
    );
    if (bundle.kind !== "hashed") throw new Error("expected a hashed bundle");
    await store.record(workspaceIdentityKey, {
      pluginId: "x@project",
      decision: "granted",
      digest: bundle.digest,
      grantedAt: "2026-09-21T00:00:00.000Z",
      sourcePath: plugins[0]?.path ?? "",
    });

    const after = await evaluateProjectHookTrust({ plugins, workspaceIdentityKey, trustFile: store.read() });
    assert.equal(after.entries[0]?.status, "trusted");
    assert.equal(retainTrustedHookMatchers(settings, after).PreToolUse?.length, 1);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：授权改写声明后自动作废（摘要不同 → stale → 仍不装载）", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-gate-stale-"));
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-gate-home-"));
  try {
    const pluginDir = await writeProjectPlugin(projectRoot, "x", COMMAND_HOOKS);
    const runtime = new PluginRuntime({ projectRoot, pilotHome });
    await runtime.refresh();
    const plugins = runtime.snapshotContributions().plugins;
    const workspaceIdentityKey = await computeWorkspaceIdentityKey(projectRoot);
    const store = new HookTrustStore(hookTrustStorePath(pilotHome));
    const granted = await computeHookBundleDigest(pluginDir, { name: "x" });
    if (granted.kind !== "hashed") throw new Error("expected a hashed bundle");
    await store.record(workspaceIdentityKey, {
      pluginId: "x@project",
      decision: "granted",
      digest: granted.digest,
      grantedAt: "2026-09-21T00:00:00.000Z",
      sourcePath: pluginDir,
    });

    // 声明被改成另一条命令：`granted.digest` 已不是当前内容 → stale → 不装载。
    await writeFile(
      join(pluginDir, "hooks", "hooks.json"),
      JSON.stringify({ PreToolUse: [{ hooks: [{ type: "command", command: "curl evil" }] }] }),
      "utf8",
    );
    const evaluation = await evaluateProjectHookTrust({ plugins, workspaceIdentityKey, trustFile: store.read() });
    assert.equal(evaluation.entries[0]?.status, "stale");
    assert.deepEqual(retainTrustedHookMatchers(loadPluginHooks(plugins), evaluation), {});
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：存储写路径往返（含撤销记录与父目录创建）", async () => {
  const pilotHome = await mkdtemp(join(tmpdir(), "sati-gate-store-"));
  try {
    const filePath = hookTrustStorePath(join(pilotHome, "nested"));
    const store = new HookTrustStore(filePath);
    await store.record("ws", {
      pluginId: "x@project",
      decision: "granted",
      digest: "sha256:ab",
      grantedAt: "2026-09-21T00:00:00.000Z",
      sourcePath: "/p",
    });
    assert.equal(new HookTrustStore(filePath).read().entries[hookTrustKey("ws", "x@project")]?.digest, "sha256:ab");

    await store.record("ws", {
      pluginId: "x@project",
      decision: "revoked",
      digest: "sha256:ab",
      grantedAt: "2026-09-21T01:00:00.000Z",
      sourcePath: "/p",
    });
    assert.equal(new HookTrustStore(filePath).read().entries[hookTrustKey("ws", "x@project")]?.decision, "revoked");

    const written = await readFile(filePath, "utf8");
    assert.deepEqual(
      parseHookTrustFile(written),
      JSON.parse(written) as unknown, // 版本门与条目形状都合法时解析即原样
    );
    assert.equal(JSON.parse(written).version, HOOK_TRUST_STORE_VERSION);
  } finally {
    await rm(pilotHome, { recursive: true, force: true });
  }
});

test("1.2b：声明投影给出将被执行的内容（command / url / prompt / callback）", () => {
  const plugin = {
    name: "x",
    path: "/p",
    source: "project" as const,
    manifest: { name: "x" },
    hooksConfig: {
      PreToolUse: [{ hooks: [{ type: "command" as const, command: "  npx  prettier --write $FILE " }] }],
      PostToolUse: [
        { matcher: "Write", hooks: [{ type: "http" as const, url: "https://example.com/hook", if: "subagent" }] },
      ],
      SessionStart: [{ hooks: [{ type: "prompt" as const, prompt: "summarize\nthe diff" }] }],
      Stop: [{ hooks: [{ type: "callback" as const, name: "gw_cb" }] }],
    },
  } satisfies SatiLoadedPlugin;

  assert.deepEqual(summarizeHookDeclarations(plugin), [
    { event: "PreToolUse", kind: "command", summary: "npx prettier --write $FILE" },
    {
      event: "PostToolUse",
      matcher: "Write",
      kind: "http",
      summary: "https://example.com/hook",
      condition: "subagent",
    },
    { event: "SessionStart", kind: "prompt", summary: "summarize the diff" },
    { event: "Stop", kind: "callback", summary: "gw_cb" },
  ]);
});
