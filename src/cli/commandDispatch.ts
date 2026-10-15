/**
 * `sati` CLI 分发表与入口逻辑（P2.7：从 `cli/sati.ts` 拆出，`sati.ts` 只留 shebang + 触发）。
 *
 * 本模块只做三件事：版本/帮助短路、子命令表查表分发、**未命中命令回落交互式 CLI**
 * （历史行为：未知命令不报错，与无子命令同路）。各子命令实现在 `./commands/` 下，
 * 一律动态 import——`sati --version` / `--help` 与轻量命令不加载 gateway / adapters 全树。
 *
 * 分发表用 `Object.hasOwn` 查键：直接 `COMMANDS[command]` 会把 `toString` / `constructor`
 * 这类原型链上的键当成命中，落到交互式 CLI 的原语义会被破坏。
 *
 * 与 `--help` 的关系：`COMMANDS` 的键集由 `tests/cli/command-dispatch.spec.ts` 显式钉住；
 * 帮助文本里**没有** `patent-search`（历史遗漏，本次不动帮助文本，已在 PR 正文登记）。
 */

import { plainLogger as out } from "../telemetry/index.js";
import { APP_VERSION } from "../version.js";

export type CommandHandler = (argv: string[]) => Promise<void>;

export function printUsage(): void {
  out.info(`sati v${APP_VERSION} — AI agent runtime · CLI · TUI · Web · Feishu

Usage: sati [command] [options]

Commands:
  (none)                        Interactive CLI chat (default)
  tui                           Interactive terminal UI (requires a TTY)
  server                        Start the sati server (gateway + web)
  gateway setup <channel>       Set up an IM channel (feishu|weixin|wecom)
  config set <key.path> <value> Set a nested config value in sati.yaml
  config delete <key.path>      Delete a nested config value from sati.yaml
  cron <list|create|delete|stop> Manage cron tasks (requires a running server)
  chat                          Search chat history
  hooks <list|approve|revoke>   Review project plugin hooks (unreviewed ones are not loaded)
  browsers [--doctor] [--json]  Probe browser backends (ego lite / BrowserOS neo / browser-use / @playwright/mcp)
  skills migrate                Migrate skills from other agents
  update [--check|--restart]    Update sati from the git remote

Options:
  -v, --version                 Print the application version
  -h, --help                    Show this help message`);
}

/**
 * 子命令表。键 = `argv[0]`；未命中的命令（含未知命令）回落交互式 CLI。
 * `server` / `tui` 的重活都在各自模块内部按需 import，不在本文件展开。
 */
export const COMMANDS: Record<string, CommandHandler> = {
  server: async argv => {
    const { runServerCommand } = await import("./commands/serverCommand.js");
    await runServerCommand(argv);
  },
  tui: async () => {
    const { runTuiCommand } = await import("./commands/tuiCommand.js");
    await runTuiCommand();
  },
  gateway: async argv => {
    const sub = argv[1];
    if (sub === "setup") {
      const { runGatewaySetup } = await import("./commands/gatewaySetup.js");
      await runGatewaySetup(argv.slice(2));
      return;
    }
    out.error("Usage: sati gateway setup [feishu|weixin|wecom]");
    process.exitCode = 1;
  },
  config: async argv => {
    const { runConfigCommand } = await import("./commands/configSet.js");
    await runConfigCommand(argv.slice(1));
  },
  cron: async argv => {
    const { runCronCommand } = await import("./commands/cronCommand.js");
    await runCronCommand(argv.slice(1));
  },
  update: async argv => {
    const { runUpdateCommand } = await import("./commands/updateCommand.js");
    await runUpdateCommand(argv.slice(1));
  },
  skills: async argv => {
    const { runSkillsCommand } = await import("./commands/skillsCommand.js");
    await runSkillsCommand(argv.slice(1));
  },
  browsers: async argv => {
    const { runBrowserBackendProbes, formatBrowserBackendMatrix } = await import("./commands/browserBackends.js");
    const probes = await runBrowserBackendProbes({
      doctorCheck: argv.includes("--doctor"),
    });
    if (argv.includes("--json")) {
      out.info(JSON.stringify(probes, null, 2));
      return;
    }
    out.info(formatBrowserBackendMatrix(probes));
  },
  chat: async argv => {
    const { runChatSearchCli } = await import("./commands/chatSearch.js");
    await runChatSearchCli(argv.slice(1));
  },
  hooks: async argv => {
    const { runHookTrustCli } = await import("./commands/hookTrust.js");
    process.exitCode = await runHookTrustCli({ argv: argv.slice(1) });
  },
  "patent-search": async argv => {
    const { main: runPatentSearchCli } = await import("./commands/patentSearch.js");
    process.exitCode = await runPatentSearchCli(argv.slice(1));
  },
};

/** 交互式 CLI（无子命令 / 未知命令）。本地 gateway 装配失败时 CLI 自身不设兜底网关。 */
async function runInteractiveChat(argv: string[]): Promise<void> {
  const { createLocalGateway } = await import("./createLocalGateway.js");
  const { CliChannel } = await import("../adapters/channel/cli/CliChannel.js");
  const { installGlobalProxy } = await import("./proxy.js");
  await installGlobalProxy();
  const { gateway: fallbackGateway } = createLocalGateway({ projectRoot: process.cwd() });
  await new CliChannel({ argv, projectKey: process.cwd() }).start({ gateway: fallbackGateway });
}

/**
 * 查表：命中返回处理器，未命中返回 undefined（调用方回落交互式 CLI）。
 *
 * 用 `Object.hasOwn` 而非 `COMMANDS[command]`：后者对 `toString` / `constructor` /
 * `__proto__` 这类原型链键返回真值，会让这些参数名走进子命令分支而非交互式 CLI。
 */
export function resolveCommand(command: string | undefined): CommandHandler | undefined {
  return command !== undefined && Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    out.info(APP_VERSION);
    return;
  }
  if (command === "--help" || command === "-h" || command === "help") {
    printUsage();
    return;
  }
  const handler = resolveCommand(command);
  if (handler) {
    await handler(argv);
    return;
  }
  await runInteractiveChat(argv);
}
