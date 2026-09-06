import { existsSync as defaultExistsSync } from "node:fs";
import { posix, win32 } from "node:path";

/**
 * Agent 命令 shell 解析（2026-09，移植自 PilotDeck desktop-v2026.09.02 #537）。
 *
 * bash 工具与后台任务此前依赖 `spawn({ shell: true })`，Windows 落到
 * cmd.exe、Unix 落到 /bin/sh——模型生成的 bash 语义命令（`&&`、引号、
 * `$(...)`）在 cmd 下失败率高。此模块统一解析 agent 命令使用的 shell：
 * 优先 bash（含 Windows Git Bash 探测），`SATI_SHELL_PATH` 显式覆盖，
 * cmd/pwsh 兜底，全部不可用则 fail-loud。
 */

export type CommandShellKind = "bash" | "sh" | "cmd" | "pwsh" | "custom";

export type CommandShell = {
  /** 传给 spawn 的 shell 可执行文件。 */
  shell: string;
  /** 包装命令行的参数（显式形式，避免 `shell: true` 的平台默认差异）。 */
  args: (command: string) => string[];
  kind: CommandShellKind;
  /** Windows 下由调用方全权控制引号（cmd 需要）。 */
  windowsVerbatimArguments: boolean;
};

export type CommandShellResolverOptions = {
  platform?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  commandAvailable?: (command: string) => boolean;
};

const DEFAULT_GIT_BASH_PATHS = [
  "C:\\Program Files\\Git\\bin\\bash.exe",
  "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
] as const;

const POSIX_BASH_NAMES = new Set(["bash", "bash.exe"]);
const POSIX_SH_NAMES = new Set(["sh", "sh.exe", "dash", "dash.exe", "ksh", "ksh.exe", "mksh", "mksh.exe"]);
const CMD_NAMES = new Set(["cmd", "cmd.exe"]);
const PWSH_NAMES = new Set(["pwsh", "pwsh.exe", "powershell", "powershell.exe"]);

function bashShell(shellPath: string): CommandShell {
  return {
    shell: shellPath,
    args: command => ["-c", command],
    kind: "bash",
    windowsVerbatimArguments: false,
  };
}

function shShell(shellPath: string): CommandShell {
  return {
    shell: shellPath,
    args: command => ["-c", command],
    kind: "sh",
    windowsVerbatimArguments: false,
  };
}

function cmdShell(shellPath: string): CommandShell {
  return {
    shell: shellPath,
    args: command => ["/d", "/s", "/c", command],
    kind: "cmd",
    windowsVerbatimArguments: true,
  };
}

function pwshShell(shellPath: string): CommandShell {
  return {
    shell: shellPath,
    args: command => ["-Command", command],
    kind: "pwsh",
    windowsVerbatimArguments: true,
  };
}

function shellFromPath(shellPath: string): CommandShell {
  const name = shellPath.split(/[\\/]/).pop() ?? shellPath;
  const lowered = name.toLowerCase();
  if (POSIX_BASH_NAMES.has(lowered)) return bashShell(shellPath);
  if (POSIX_SH_NAMES.has(lowered)) return shShell(shellPath);
  if (CMD_NAMES.has(lowered)) return cmdShell(shellPath);
  if (PWSH_NAMES.has(lowered)) return pwshShell(shellPath);
  // 自定义 shell 按 POSIX `-c` 约定调用：由显式配置者自行保证兼容。
  return {
    shell: shellPath,
    args: command => ["-c", command],
    kind: "custom",
    windowsVerbatimArguments: false,
  };
}

function findOnPath(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: string,
  existsSync: (path: string) => boolean,
): string | undefined {
  const pathMod = platform === "win32" ? win32 : posix;
  const pathValue = env.PATH ?? env.Path ?? "";
  const wantsExeSuffix = platform === "win32" && !/\.(exe|com|bat|cmd)$/i.test(name);
  const candidates = wantsExeSuffix ? [`${name}.exe`, name] : [name];
  for (const dir of pathValue.split(pathMod.delimiter)) {
    if (!dir) continue;
    for (const candidate of candidates) {
      const full = pathMod.join(dir, candidate);
      if (existsSync(full)) return full;
    }
  }
  return undefined;
}

function defaultCommandAvailable(
  command: string,
  platform: string,
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): boolean {
  if (command.includes("/") || command.includes("\\") || win32.isAbsolute(command)) {
    return existsSync(command);
  }
  return findOnPath(command, env, platform, existsSync) !== undefined;
}

/** 解析 agent 前台/后台命令使用的默认 shell。 */
export function resolveDefaultCommandShell(options: CommandShellResolverOptions = {}): CommandShell {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const existsSync = options.existsSync ?? defaultExistsSync;
  const commandAvailable =
    options.commandAvailable ?? ((command: string) => defaultCommandAvailable(command, platform, env, existsSync));

  const configured = env.SATI_SHELL_PATH;
  if (configured) {
    if (!commandAvailable(configured)) {
      throw new Error(`Configured Sati shell was not found: ${configured}`);
    }
    return shellFromPath(configured);
  }

  if (platform !== "win32") {
    if (existsSync("/bin/bash")) return bashShell("/bin/bash");
    const bash = findOnPath("bash", env, platform, existsSync);
    if (bash) return bashShell(bash);
    return shShell("/bin/sh");
  }

  for (const gitBash of DEFAULT_GIT_BASH_PATHS) {
    if (existsSync(gitBash)) return bashShell(gitBash);
  }

  const cmd = env.ComSpec || "cmd.exe";
  if (commandAvailable(cmd)) return cmdShell(cmd);
  if (commandAvailable("pwsh.exe")) return pwshShell("pwsh.exe");

  throw new Error("No supported Sati command shell found. Install Git Bash, cmd.exe, or PowerShell 7 (pwsh.exe).");
}

let cachedShell: CommandShell | undefined;

/**
 * 进程级解析结果（env/platform 进程内不变）。测试请直接调用
 * `resolveDefaultCommandShell(options)` 注入假环境。
 */
export function getSatiCommandShell(): CommandShell {
  cachedShell ??= resolveDefaultCommandShell();
  return cachedShell;
}
