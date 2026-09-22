/**
 * `sati hooks` —— 项目级 hook 信任的 CLI 出口（1.2b）。
 *
 * 为什么必须有这一条：强制期把「未评审的项目 hook」挡在 `HookRuntime` 之外，
 * 若只有 Web 界面能授权，纯 CLI/TUI 用户就会看到自己的项目 hook 静默失效而无处同意。
 * 本命令与网关的 `hook_trust_list` / `hook_trust_decide` 走**同一个服务**
 * （`createHookTrustService`），只是入口不同。
 *
 * 项目根取 canonical（worktree 与主仓库同一身份、子目录调用也能找到
 * `.sati/plugins`），与网关侧的工作区身份键口径一致。
 */
import { findCanonicalProjectRoot } from "../../shared/paths/findCanonicalProjectRoot.js";
import { resolvePilotHome } from "../../pilot/index.js";
import { PluginRuntime } from "../../extension/plugins/runtime/PluginRuntime.js";
import { HookTrustStore, hookTrustStorePath } from "../../extension/plugins/trust/index.js";
import { createHookTrustService } from "../hookTrustService.js";

export type RunHookTrustCliOptions = {
  argv: string[];
  /** 缺省取 cwd 的 canonical 项目根。 */
  projectRoot?: string;
  pilotHome?: string;
  /** 缺省 `process.stdout.write`。 */
  write?: (text: string) => void;
};

const USAGE = `Usage: sati hooks <command> [options]

Commands:
  list [--json]           List project hook declarations and their trust status
  approve <pluginId>      Grant the current content of a project plugin's hooks
  revoke <pluginId>       Revoke a previously granted project plugin

Trust is bound to the plugin directory's content digest: editing the declaration
(or any file in the plugin directory) invalidates the grant and requires review
again. Unreviewed project hooks are not loaded.`;

export async function runHookTrustCli(options: RunHookTrustCliOptions): Promise<number> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const [subcommand, ...rest] = options.argv;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    write(`${USAGE}\n`);
    return 0;
  }
  if (subcommand !== "list" && subcommand !== "approve" && subcommand !== "revoke") {
    write(`${USAGE}\n`);
    return 1;
  }

  const pilotHome = options.pilotHome ?? resolvePilotHome(process.env);
  const projectRoot = options.projectRoot ?? (await findCanonicalProjectRoot(process.cwd()));
  const store = new HookTrustStore(hookTrustStorePath(pilotHome));
  const service = createHookTrustService({
    // 发现面与网关侧同口径：同一个项目根 + 新建一份插件运行时（命令是一次性进程）。
    resolveProject: () => ({ projectRoot, pluginRuntime: new PluginRuntime({ projectRoot, pilotHome }) }),
    store,
  });

  if (subcommand === "list") {
    const result = await service.list({ projectKey: projectRoot });
    if (rest.includes("--json")) {
      write(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    write(`${formatHookTrustList(result)}\n`);
    return 0;
  }

  const pluginId = rest[0];
  if (pluginId === undefined) {
    write(`${USAGE}\n`);
    return 1;
  }
  const result = await service.decide({
    projectKey: projectRoot,
    pluginId,
    verdict: subcommand === "approve" ? "grant" : "revoke",
  });
  if (!result.applied) {
    write(
      `${subcommand === "approve" ? "approve" : "revoke"} ${pluginId}: not applied (${result.reason ?? "unknown"})\n`,
    );
    return 1;
  }
  write(
    `${subcommand === "approve" ? "approve" : "revoke"} ${pluginId}: applied (status=${result.entry?.status ?? "?"})\n`,
  );
  return 0;
}

/** 文本输出：状态 + 声明原文（看不见内容的授权不是授权）。 */
export function formatHookTrustList(result: {
  workspaceIdentityKey: string;
  entries: Array<{
    pluginId: string;
    status: string;
    pluginRoot: string;
    detail?: string;
    digest?: string;
    hooks: Array<{ event: string; matcher?: string; kind: string; summary: string; condition?: string }>;
  }>;
}): string {
  if (result.entries.length === 0) {
    return "No project plugins declare hooks in this project.";
  }
  const lines: string[] = [];
  for (const entry of result.entries) {
    lines.push(`${entry.pluginId}  [${entry.status}]  ${entry.pluginRoot}`);
    if (entry.detail !== undefined) lines.push(`  reason: ${entry.detail}`);
    if (entry.digest !== undefined) lines.push(`  digest: ${entry.digest}`);
    for (const hook of entry.hooks) {
      const matcher = hook.matcher === undefined ? "*" : hook.matcher;
      const condition = hook.condition === undefined ? "" : ` (if: ${hook.condition})`;
      lines.push(`  ${hook.event}[${matcher}] ${hook.kind}: ${hook.summary}${condition}`);
    }
    if (entry.status !== "trusted") {
      lines.push(`  → approve with: sati hooks approve ${entry.pluginId}`);
    }
  }
  return lines.join("\n");
}
