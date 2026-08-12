/**
 * egoSession — Sati 侧统一的 ego-browser (ego lite) 执行封装。
 *
 * 定位：专利域（及未来其他域）新增的浏览器自动化代码统一经本模块执行
 * `ego-browser nodejs`，避免各调用方各自维护 heredoc 构造 / 错误处理 /
 * 输出解析（历史上存在三套重复实现：内置 `ego_browser` 工具、
 * nuo-patent vendor、patent-download Python 脚本）。
 *
 * 核心设计：
 * - 会话级 task space 命名（`sati-<domain>-<sessionId>`）：同一 agent 会话内
 *   多次调用复用同一浏览器任务空间，登录态与已开 tab 跨调用保留（warm），
 *   避免 nuo-patent 每请求新建随机 space 再销毁的开销。
 * - 与内置 `ego_browser` 工具共用 `NodeShellCommandRunner` 与 PATH 注入策略
 *   （GUI 启动的进程 PATH 常缺 `~/.local/bin`，ego lite 的 CLI 就装在那里）。
 * - cliLog 输出走 stderr，本模块统一合并 stdout+stderr 并截断；脚本内用
 *   `cliLog('EGO_<TAG>:' + JSON.stringify(payload))` 返回结构化结果，
 *   由 `extractTaggedJson` 解析。
 */

import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NodeShellCommandRunner, type SatiCommandRunner } from "../../../tool/builtin/bash/commandRunner.js";

const DEFAULT_COMMAND_NAME = "ego-browser";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 500_000;
/** heredoc 结束标记（egoBrowser 工具输入校验共用同一值，避免两处漂移）。 */
export const EGO_HEREDOC_MARKER = "EGO_SCRIPT_EOF";

export type EgoSessionOptions = {
  /** CLI 命令名（默认 "ego-browser"）。 */
  commandName?: string;
  /** 默认执行超时（默认 90_000ms）。 */
  defaultTimeoutMs?: number;
  /** timeoutMs 硬上限（默认 300_000ms）。 */
  maxTimeoutMs?: number;
  /** 定位 `~/.local/bin` 的 home 目录（默认 os.homedir()，测试可注入）。 */
  homeDir?: string;
  /** 额外 PATH 目录，默认 `["<home>/.local/bin"]`。 */
  pathEntries?: string[];
  /** 返回 stdout 的软上限字节数（默认 500_000）。 */
  maxOutputBytes?: number;
  /** 平台覆盖（测试缝，默认 process.platform）。 */
  platform?: NodeJS.Platform;
  /** 环境覆盖（测试缝，默认 process.env）——用于 CLI 可执行文件在 PATH 中的探测。 */
  env?: NodeJS.ProcessEnv;
  /** 底层 shell runner（测试缝）。 */
  runner?: SatiCommandRunner;
};

export type EgoRunOptions = {
  cwd: string;
  /** 整体执行超时，默认 options.defaultTimeoutMs。 */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type EgoScriptResult = {
  /** 合并 stdout+stderr 并按 maxOutputBytes 截断后的文本。 */
  output: string;
  /** 原始 stdout（未截断）。 */
  stdout: string;
  /** 原始 stderr（未截断；cliLog 输出通常在这里）。 */
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
};

export type EgoAvailability = { ok: true } | { ok: false; code: "unavailable" | "setup_required"; reason: string };

/**
 * 统一的 ego-browser 执行会话。实例无状态，可跨调用复用；
 * 可用性检查实时执行（不缓存，避免安装/升级后 stale）。
 */
export class EgoBrowserSession {
  private readonly commandName: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly homeDir: string;
  private readonly pathEntries: string[];
  private readonly maxOutputBytes: number;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly runner: SatiCommandRunner;

  constructor(options: EgoSessionOptions = {}) {
    this.commandName = options.commandName ?? DEFAULT_COMMAND_NAME;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
    this.homeDir = options.homeDir ?? homedir();
    this.pathEntries = options.pathEntries ?? [join(this.homeDir, ".local", "bin")];
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.runner = options.runner ?? new NodeShellCommandRunner();
  }

  /**
   * 静态可用性检查：平台必须为 darwin，且 CLI 可执行文件存在。
   * @param env 可选环境覆盖（默认构造时的 env）——工具层透传 per-call 的
   *   `context.env`，避免测试/运行时 PATH 差异污染探测结果。
   */
  checkAvailability(env?: NodeJS.ProcessEnv): EgoAvailability {
    if (this.platform !== "darwin") {
      return {
        ok: false,
        code: "unavailable",
        reason: "ego-browser (ego lite) only supports macOS.",
      };
    }
    if (!this.isCommandExecutable(env ?? this.env)) {
      return {
        ok: false,
        code: "setup_required",
        reason:
          "ego-browser CLI not found. Install ego lite (https://lite.ego.app/), complete first-run onboarding, and confirm `ego-browser` is on the PATH (usually ~/.local/bin/ego-browser).",
      };
    }
    return { ok: true };
  }

  /**
   * 连接探针：执行 `ego-browser nodejs -e "cliLog(...)"` 确认 ego lite 浏览器
   * 真实可达（比 `--doctor` 兼容性好——`--doctor` 仅较新 CLI 提供）。
   * @returns 探针执行成功且输出含探针标记时 true。
   */
  async runConnectionProbe(timeoutMs?: number): Promise<boolean> {
    const probeTimeout = timeoutMs ?? 8_000;
    try {
      const result = await this.runner.run(`${this.commandName} nodejs -e "cliLog('EGO_DOCTOR_OK')"`, {
        cwd: process.cwd(),
        env: this.env,
        timeoutMs: probeTimeout,
      });
      if (result.timedOut || result.exitCode !== 0) return false;
      return `${result.stdout}\n${result.stderr}`.includes("EGO_DOCTOR_OK");
    } catch {
      return false;
    }
  }

  /**
   * 会话级 task space 命名：`sati-<domain>[-<sessionId>]`。
   * 同一 sessionId + domain 复用同一空间 → 登录态与 tab 跨调用保留。
   */
  taskSpaceName(domain: string, sessionId?: string): string {
    const base = `sati-${domain}`;
    if (sessionId) return `${base}-${sessionId}`;
    return base;
  }

  /**
   * 执行一段 ego-browser 脚本（heredoc body）。
   * 脚本内 helper 已预加载，最终结果用 `cliLog(...)` 输出。
   */
  async runScript(script: string, options: EgoRunOptions): Promise<EgoScriptResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    const command = this.buildCommand(script);
    const env = this.buildEnv(options.env ?? process.env);
    try {
      const result = await this.runner.run(command, {
        cwd: options.cwd,
        env,
        timeoutMs,
        signal: options.signal,
      });
      const combined = [result.stdout, result.stderr].filter(t => t.length > 0).join("\n");
      return {
        output: this.truncate(combined),
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: result.durationMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`ego-browser failed to start: ${message}`);
    }
  }

  /**
   * 从脚本输出中提取 `EGO_<TAG>:<json>` 标记行的 JSON payload。
   * 找不到标记返回 null；一行多个标记只取第一个。
   */
  extractTaggedJson<T>(output: string, tag: string): T | null {
    const prefix = `EGO_${tag}:`;
    for (const line of output.split("\n")) {
      const idx = line.indexOf(prefix);
      if (idx === -1) continue;
      const payload = line.slice(idx + prefix.length).trim();
      try {
        return JSON.parse(payload) as T;
      } catch {
        return null;
      }
    }
    return null;
  }

  /** 确保输出目录存在（下载/录屏前调用）。 */
  ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  }

  private buildCommand(script: string): string {
    return `${this.commandName} nodejs <<'${EGO_HEREDOC_MARKER}'\n${script}\n${EGO_HEREDOC_MARKER}`;
  }

  private buildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const existingPath = base.PATH ?? "";
    const segments = existingPath.length > 0 ? existingPath.split(":") : [];
    for (const entry of this.pathEntries) {
      if (entry && entry.length > 0 && !segments.includes(entry)) {
        segments.push(entry);
      }
    }
    return { ...base, PATH: segments.join(":") };
  }

  private isCommandExecutable(env: NodeJS.ProcessEnv): boolean {
    const localBin = join(this.homeDir, ".local", "bin");
    const pathSegments = (env.PATH ?? "").split(":").filter(s => s.length > 0);
    const candidates = [
      join(localBin, this.commandName),
      ...pathSegments.map(segment => join(segment, this.commandName)),
    ];
    return candidates.some(isExecutableFile);
  }

  private truncate(text: string): string {
    return text.length > this.maxOutputBytes ? `${text.slice(0, this.maxOutputBytes)}…\n[output truncated]` : text;
  }
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** 归一化专利号：去空白与分隔符、转大写。 */
export function normalizePatentNumber(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[\s\-:/]/g, "");
}
