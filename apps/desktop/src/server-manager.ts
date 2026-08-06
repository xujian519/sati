/**
 * ServerManager — owns the satiui Express server child process.
 *
 * Adapted from OpenClaw's GatewayManager (apps/electron/src/gateway-manager.ts).
 * Key differences:
 *   - Spawns `node-bin/node satiui/server/index.js` (instead of entry.js gateway)
 *   - Three tarballs to extract (satiui/server resolves sati-memory-core
 *     via `../../../sati-memory-core/lib/index.js`, so all three must be siblings):
 *       Resources/satiui-bundle.tar         → Resources/satiui/
 *       Resources/sati-main-bundle.tar     → Resources/sati-main/
 *       Resources/sati-memory-core-bundle.tar → Resources/edgeclaw-memory-core/
 *   - Sets BUN_BIN, SATI_MAIN_DIR so the server can spawn `bun` subprocesses
 *   - satiui /health responds with `{status: "ok", ...}` (not `{ok: true}`)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
const execFile = promisify(execFileCb);
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";

const DEFAULT_PORT_START = 18790;
const DEFAULT_PORT_END = 18799;
// Gateway port. Default 19789 matches the canonical default in
// src/cli/sati.ts (`readPort(argv) ?? SATI_GATEWAY_PORT ?? 19789`) and
// sati-bridge.js, so the desktop and standalone `sati server` agree.
//
// Resolution order (first valid integer in 1..65535 wins):
//   1. SATI_GATEWAY_PORT environment variable (existing escape hatch)
//   2. `gatewayPort` at the top level of ~/.sati/sati.yaml — lets desktop
//      users pin a non-conflicting port (e.g. when another service already
//      occupies 19789) without going through launchd/launchctl env.
//   3. 19789 default.
//
// Note: the YAML key is desktop-only. The standalone `sati server` CLI does
// not read it — use `sati server --port` / SATI_GATEWAY_PORT there.
function readGatewayPort(): number {
  const envPort = Number(process.env.SATI_GATEWAY_PORT);
  if (Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535) return envPort;

  try {
    const configPath = path.join(getSatiDir(), "sati.yaml");
    if (fsSync.existsSync(configPath)) {
      const parsed = parseYaml(fsSync.readFileSync(configPath, "utf8")) as { gatewayPort?: unknown } | null | undefined;
      const yamlPort = Number(parsed?.gatewayPort);
      if (Number.isInteger(yamlPort) && yamlPort >= 1 && yamlPort <= 65535) return yamlPort;
    }
  } catch {
    /* best-effort: unreadable/malformed config falls back to default */
  }
  return 19789;
}
const GATEWAY_PORT = readGatewayPort();
const HEALTH_POLL_MS = 1500;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;
const GATEWAY_STARTUP_TIMEOUT_MS = 45_000;
const SHUTDOWN_SIGTERM_WAIT_MS = 5000;
const ORPHAN_TERM_WAIT_MS = 3000;
const STABLE_RUN_RESET_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000] as const;

// Reasoning models (e.g. MiniMax-M2.7-highspeed, DeepSeek-R1) emit large
// <think>/reasoning blocks that consume the output budget BEFORE the actual
// answer. Anthropic SDK's getMaxOutputTokensForModel falls back to 32_000 for
// unknown model names but a downstream GrowthBook gate (tengu_otk_slot_v1) can
// silently cap that to 8_000. 8k is barely enough room for thinking + a short
// answer; 16k leaves headroom without risking provider rejections (MiniMax
// caps at ~64k, OpenAI-compatible Chat caps at 32k for most providers).
//
// User can override via SATI_MAX_OUTPUT_TOKENS env or
// agents.main.params.maxOutputTokens in ~/.sati/sati.yaml (the latter is
// wired up in ui/server/services/satiConfig.js → buildRuntimeEnv).
const REASONING_FRIENDLY_MAX_OUTPUT_TOKENS = "16000";

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 生成子进程并镜像 stdout/stderr 到日志文件。统一 gateway/server 两个
 * spawn 块的日志管道（stdout/stderr pipe + end-on-exit），并暴露 endLog
 * 供调用方在 stop()/失败路径手动 flush（stop() 会 removeAllListeners("exit")
 * 移除 exit 监听，必须手动 end 日志流否则 fd 泄漏且尾部日志丢失）。
 */
function spawnWithLog(
  argv: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; logPath: string; header?: string },
): { child: ChildProcess; endLog: () => void } {
  const logStream = fsSync.createWriteStream(options.logPath, { flags: "a" });
  logStream.write(
    `\n=== ${new Date().toISOString()} spawn ${argv.join(" ")}${options.header ? ` ${options.header}` : ""} ===\n`,
  );
  const child = spawn(argv[0], argv.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
  });
  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  const endLog = (): void => {
    if (!logStream.writableEnded) logStream.end();
  };
  child.once("exit", endLog);
  return { child, endLog };
}

function bundledBinary(binDir: string, name: string): string {
  if (process.platform === "win32") {
    const exePath = path.join(binDir, `${name}.exe`);
    if (fsSync.existsSync(exePath)) return exePath;
  }
  return path.join(binDir, name);
}

function linkDirectory(link: string, target: string): void {
  if (fsSync.existsSync(link) || !fsSync.existsSync(target)) return;
  if (process.platform === "win32") {
    fsSync.symlinkSync(target, link, "junction");
  } else {
    fsSync.symlinkSync(target, link);
  }
}

/**
 * Sati 数据目录。与 main.ts / onboarding-window.ts / src/pilot/paths.ts 一致：
 * 优先 SATI_HOME，缺省 ~/.sati。此前 desktop.server.log/.pid 硬编码 ~/.sati，
 * 在 SATI_HOME 设置时与主进程路径分歧。
 */
function getSatiDir(): string {
  return process.env.SATI_HOME || path.join(os.homedir(), ".sati");
}

function getPidFilePath(): string {
  return path.join(getSatiDir(), "desktop.server.pid");
}

async function ensureSatiDir(): Promise<void> {
  await fs.mkdir(getSatiDir(), { recursive: true });
}

/**
 * Per-version runtime extraction root.
 *
 * macOS protects `/Applications/<App>.app/Contents/Resources/` via SIP+TCC
 * (App Management gate, macOS 14+); writing extracted bundles there works on
 * first launch but can be wiped silently on app upgrade and is technically a
 * violation of Apple's "app bundle is read-only after install" guideline.
 *
 * The proper home is `~/Library/Application Support/<App>/runtime/<version>/`,
 * which is per-user, writable, survives macOS upgrades, and is the standard
 * location Electron's `app.getPath('userData')` resolves to.
 *
 * We key on the Sati bundle version so that upgrading the app forces a
 * fresh extraction (otherwise stale source files from the previous version
 * would silently win). Old version dirs are GC'd on next startup via
 * `cleanupStaleRuntimeVersions()`.
 */
function getRuntimeBaseDir(version: string): string {
  return path.join(os.homedir(), "Library", "Application Support", "Sati", "runtime", version);
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickAvailablePort(): Promise<number> {
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(`No free desktop server port in range ${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`);
}

function getServerLogPath(): string {
  return path.join(getSatiDir(), "desktop.server.log");
}

function readTailSafe(filePath: string, maxBytes: number): string {
  try {
    const stat = fsSync.statSync(filePath);
    const fd = fsSync.openSync(filePath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fsSync.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    return "(no log)";
  }
}

async function readPidFile(): Promise<number | null> {
  try {
    const raw = await fs.readFile(getPidFilePath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // On Windows, process.kill(pid, 0) can throw EPERM if the process
    // exists but belongs to another user — treat as "exists".
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

function forceKillPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid} /T 2>NUL`, {
        stdio: "ignore",
        timeout: 5000,
        shell: "cmd.exe",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch {
    /* ignore */
  }
}

async function waitForProcessExit(pid: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(50);
  }
}

/** 统一优雅终止：SIGTERM → 轮询退出 → SIGKILL（child/gateway/孤儿进程共用）。 */
async function killPidGracefully(pid: number, waitMs: number): Promise<void> {
  if (!processExists(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
  }
  await waitForProcessExit(pid, waitMs);
  if (processExists(pid)) {
    forceKillPid(pid);
  }
}

/** 异步探测端口是否已被监听（替代 execSync lsof 轮询，不阻塞事件循环/主线程）。 */
function portIsListening(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** 读取进程命令行（杀进程前验证身份用；读取失败返回 null）。 */
async function processCommandLine(pid: number): Promise<string | null> {
  try {
    if (process.platform === "win32") {
      // async execFile 避免 wmic 阻塞 Electron 主进程（与 macOS 分支一致）。
      const { stdout } = await execFile(
        "wmic",
        ["process", "where", `processid=${pid}`, "get", "commandline", "/value"],
        { timeout: 3000 },
      );
      const m = /CommandLine=([\s\S]*?)(?:\r?\n\r?\n|$)/.exec(stdout.trim());
      return m?.[1]?.trim() ?? null;
    }
    // `ps -p PID -o command=` 在 macOS/Linux 输出单行、无表头（`-o` 指定
    // 字段时省略表头行）。取最后一行（有表头环境亦兼容），而不是 [1]。
    // 用 async execFile 避免 execSync 阻塞 Electron 主进程。
    const { stdout } = await execFile("ps", ["-p", String(pid), "-o", "command="], { timeout: 3000 });
    const line = stdout.trim().split("\n").at(-1)?.trim();
    return line && line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/**
 * 判断 PID 是否为 Sati 运行时进程（UI server / gateway / cron daemon）。
 * 仅凭 PID 或端口占用就杀会误伤 PID 复用或端口被无关进程占用的场景。
 */
async function isSatiRuntimeProcess(pid: number): Promise<boolean> {
  const cmd = await processCommandLine(pid);
  if (!cmd) return false; // 读不到命令行时不杀，宁可放过不可误杀
  return /satiui\/server|dist\/src\/cli\/sati|daemonMain|ui\/server\/index\.js/.test(cmd);
}

async function cleanupStaleOrOrphanPid(): Promise<void> {
  const pid = await readPidFile();
  if (pid === null) return;
  if (!processExists(pid)) {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  // 身份验证：pid 文件记录的进程被强杀后，PID 可能已被系统回收给无关
  // 进程；仅凭 PID 存在就杀会误伤无辜进程。
  if (!(await isSatiRuntimeProcess(pid))) {
    console.warn(`[desktop] refusing to kill pid ${pid}: not a Sati runtime process`);
    return;
  }
  await killPidGracefully(pid, SHUTDOWN_SIGTERM_WAIT_MS);
  try {
    await fs.unlink(getPidFilePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Poll http://127.0.0.1:<port>/health until it returns `{status: "ok"}` or
 * we hit the startup timeout.
 *
 * If `child` is provided, we additionally short-circuit the moment the
 * child process exits (exitCode !== null || signalCode !== null). Without
 * this fast-fail, a child that crashes ~10ms after spawn (e.g. because
 * load-env.js threw on missing config) still keeps us polling for the full
 * 60-second deadline before the user sees the error dialog.
 */
async function waitForServerHealth(port: number, child?: ChildProcess): Promise<void> {
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Server child exited before becoming healthy (code=${
          child.exitCode ?? "null"
        }, signal=${child.signalCode ?? "null"})`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body && body.status === "ok") return;
      }
    } catch {
      /* retry until deadline */
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`Server health check failed within ${STARTUP_HEALTH_TIMEOUT_MS}ms`);
}

export type ServerManagerOptions = {
  /**
   * When true, spawns from the dev source tree.
   * When false (packaged app), uses `process.resourcesPath` from Electron.
   */
  dev?: boolean;
  /**
   * Repo root (the parent of `satiui/` and `sati-main/`).
   * Required when `dev: true`.
   */
  devRepoRoot?: string;
  /**
   * Bundle version (typically `app.getVersion()`). Used to pick the per-version
   * runtime extraction directory under `~/Library/Application Support/Sati/
   * runtime/<version>/`. Required when `dev: false` so that upgrading the app
   * forces a fresh re-extraction of bundled tarballs.
   */
  appVersion?: string;
};

export type ServerManagerEvents = {
  ready: [port: number];
  error: [error: Error];
  restarting: [attempt: number];
  "max-restarts": [];
  /**
   * Phase-label updates emitted while start() is in flight. Consumed by
   * the splash window so users get visible feedback during the long
   * first-launch tarball extraction. Strings are user-facing Chinese
   * copy — keep them short (≤ 24 chars), end-state-shaped, and
   * deliberately *abstracted* away from internal bundle names: users
   * shouldn't see "satiui" or "sati-main", they should see
   * "正在解压应用资源 (1/3)" etc. The internal labels are mapped at the
   * resolvePaths() call site.
   */
  progress: [phase: string];
};

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private readonly dev: boolean;
  private readonly devRepoRoot: string | undefined;
  private readonly appVersion: string | undefined;

  private child: ChildProcess | null = null;
  private gatewayChild: ChildProcess | null = null;
  /** UI server 日志流手动 flush 句柄（stop() 移除 exit 监听后仍需 end 日志流）。 */
  private serverLogEnd: (() => void) | null = null;
  private port: number | null = null;
  private stopRequested = false;
  private startPromise: Promise<{ port: number }> | null = null;

  private restartAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlerBound = false;
  /** 重启任务的 spawn 流程进行中（防连环崩溃时并发重启 + error 双发）。 */
  private restartInFlight = false;
  /**
   * Set to true while the very first start() is in flight. The exit watchdog
   * checks this and refuses to schedule a restart until the initial start
   * either succeeds or rejects, otherwise an early-crashing child triggers
   * concurrent restart attempts that race against the still-pending health
   * polling loop (and double-emit "error" events).
   */
  private initialStartInFlight = false;

  constructor(options: ServerManagerOptions = {}) {
    super();
    this.dev = options.dev ?? false;
    this.devRepoRoot = options.devRepoRoot;
    this.appVersion = options.appVersion;
  }

  /**
   * Best-effort removal of an existing extraction directory.
   *
   * Fast path is `fs.rm` with recursive+force. On macOS this can still fail
   * with ENOTEMPTY: bundled `.app` payloads (e.g. an accidentally bundled
   * electron/dist/Electron.app) ship codesigned files that resist unlink(),
   * so Node's internal rmdir() on a parent directory finds it non-empty.
   * The shell's `rm -rf` is more tolerant (it keeps going past per-file
   * failures); if even that fails, remove everything except node_modules
   * and let the subsequent `tar xf` overwrite it incrementally — the same
   * strategy as .cache/sati-bundles/install-desktop-runtime.sh. Orphaned
   * .pnpm entries are never require()d, so the new tarball's versions win.
   */
  private async removeExistingExtraction(destDir: string): Promise<void> {
    try {
      await fs.rm(destDir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw err;
    }
    // ENOTEMPTY: 兜底 1 — shell rm -rf（逐个文件失败后继续，比 fs.rm 宽容）
    try {
      execSync(`rm -rf "${destDir}"`, { stdio: "ignore", timeout: 30_000 });
      return;
    } catch {
      /* fall through to targeted cleanup */
    }
    // 兜底 2 — 定向清理：保留 node_modules（可能仍含删不掉的被占用文件），
    // 其余条目尽力删除，残留由 tar 解包增量覆盖。
    let entries: string[] = [];
    try {
      entries = await fs.readdir(destDir);
    } catch {
      return; // 目录已消失或不可读：后续 mkdir + tar 自会处理
    }
    for (const entry of entries) {
      if (entry === "node_modules") continue;
      try {
        await fs.rm(path.join(destDir, entry), { recursive: true, force: true });
      } catch {
        /* best-effort; leftovers are overwritten by tar */
      }
    }
  }

  /**
   * Extract a tarball into `<runtimeBaseDir>/<destDirName>/`, idempotent via
   * marker. The marker stores the source tarball mtime+size so that if the
   * bundled tar is updated (e.g. after an in-place reinstall over the same
   * version) we re-extract automatically.
   *
   * Switched from `execSync('tar xf ...')` to `await execFile('tar', ...)`
   * so the Electron main loop can keep handling IPC (in particular the
   * splash window's status-update channel) while the ~700MB total of
   * bundled tarballs is unpacked. Sync extraction blocked the main thread
   * for tens of seconds on cold APFS caches; the splash text would freeze
   * mid-update and users would assume the app crashed.
   */
  private async ensureBundleExtracted(
    tarballSourceDir: string,
    runtimeBaseDir: string,
    tarballName: string,
    destDirName: string,
    progressLabel: string,
  ): Promise<string> {
    const destDir = path.join(runtimeBaseDir, destDirName);
    const tarball = path.join(tarballSourceDir, tarballName);
    const marker = path.join(destDir, ".extracted");

    if (!fsSync.existsSync(tarball)) {
      throw new Error(`Bundle not found: ${tarball}`);
    }

    const tarStat = fsSync.statSync(tarball);
    const expectedMarker = `${tarStat.mtimeMs.toFixed(0)}-${tarStat.size}`;

    if (fsSync.existsSync(marker)) {
      try {
        const recorded = fsSync.readFileSync(marker, "utf8").trim();
        if (recorded === expectedMarker) return destDir;
      } catch {
        /* fall through and re-extract */
      }
    }

    // Single user-visible phase covers both the partial-leftover nuke and
    // the actual tar extraction — users don't care which sub-step we're
    // on, and "正在解压…" stays accurate throughout (cleanup is fast,
    // tar dominates wall-clock).
    this.emit("progress", `${progressLabel}…首次安装可能需要 30 秒`);

    if (fsSync.existsSync(destDir)) {
      // Fresh extract: nuke any partial leftover so we don't merge stale
      // + new payloads (could happen if a previous extraction was
      // interrupted). removeExistingExtraction tolerates files that resist
      // deletion (ENOTEMPTY on bundled .app payloads).
      await this.removeExistingExtraction(destDir);
    }
    await fs.mkdir(destDir, { recursive: true });

    const tarBin = process.platform === "win32" ? "tar" : "/usr/bin/tar";
    await execFile(tarBin, ["xf", tarball, "-C", destDir], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    await fs.writeFile(marker, expectedMarker);
    return destDir;
  }

  /**
   * Best-effort cleanup of `~/Library/Application Support/Sati/runtime/`
   * subdirectories belonging to other versions. Called at startup so that
   * upgrading the app reclaims disk (~1GB per stale version).
   */
  private async cleanupStaleRuntimeVersions(currentVersion: string): Promise<void> {
    const runtimeRoot = path.dirname(getRuntimeBaseDir(currentVersion));
    if (!fsSync.existsSync(runtimeRoot)) return;
    let entries: string[];
    try {
      entries = await fs.readdir(runtimeRoot);
    } catch {
      return;
    }
    // 并行删除：~1GB/版本的旧 runtime 目录串行删除会拖慢 splash 启动路径
    // （升级后首启可多等 20-60s）。并行 + best-effort，失败不影响启动。
    await Promise.allSettled(
      entries
        .filter(entry => entry !== currentVersion)
        .map(entry => fs.rm(path.join(runtimeRoot, entry), { recursive: true, force: true })),
    );
  }

  private async resolvePaths(): Promise<{
    nodeBin: string;
    bunBin: string;
    serverEntry: string;
    serverCwd: string;
    satiMainDir: string;
  }> {
    if (this.dev) {
      const root = this.devRepoRoot;
      if (!root) throw new Error("ServerManager: devRepoRoot is required when dev=true");
      return {
        nodeBin: bundledBinary(path.join(root, "apps", "desktop", "resources", "node-bin"), "node"),
        bunBin: bundledBinary(path.join(root, "apps", "desktop", "resources", "bun-bin"), "bun"),
        // Repo UI lives at ui/ (bundle tar extracts as satiui/ at runtime).
        serverEntry: path.join(root, "ui", "server", "index.js"),
        serverCwd: path.join(root, "ui"),
        satiMainDir: root,
      };
    }
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
    const resources = typeof resourcesPath === "string" ? resourcesPath : "";
    if (!resources) {
      throw new Error("ServerManager: process.resourcesPath unavailable; pass dev/devRepoRoot or run under Electron");
    }
    if (!this.appVersion) {
      throw new Error(
        "ServerManager: appVersion is required for packaged mode (pass app.getVersion() into the constructor)",
      );
    }
    const runtimeBaseDir = getRuntimeBaseDir(this.appVersion);
    fsSync.mkdirSync(runtimeBaseDir, { recursive: true });
    // Stale-version GC runs silently — it only does work on upgrades and
    // there's nothing useful to tell the user about it. Bundling its
    // wall-clock into the next phase keeps the splash sequence shorter.
    await this.cleanupStaleRuntimeVersions(this.appVersion);

    // All three must end up as siblings inside runtimeBaseDir (resolution at
    // runtime is via ../../../ path walks). They extract to independent
    // subdirectories with no interdependency, so extraction is parallelized:
    // tar xf on Apple Silicon is CPU-bound (xz decompression) and each tar
    // only uses one core — sequential extraction leaves 3+ cores idle on
    // cold APFS caches. The later symlink wiring (dist/ etc.) only needs the
    // directories to exist, so it can stay sequential after this point.
    // SATI_TAR_PARALLEL=0 falls back to sequential extraction (e.g. on
    // mechanical disks where concurrent I/O actually loses).
    //
    // Progress labels are intentionally generic ("应用资源 (N/3)") rather
    // than naming the internal bundle (memory-core / satiui /
    // sati-main) — those names mean nothing to end users and the
    // (N/3) index gives enough sense of "how many steps left".
    const extractMemoryCore = () =>
      this.ensureBundleExtracted(
        resources,
        runtimeBaseDir,
        "sati-memory-core-bundle.tar",
        "edgeclaw-memory-core",
        "正在解压应用资源 (1/3)",
      );
    const extractSatiUi = () =>
      this.ensureBundleExtracted(resources, runtimeBaseDir, "satiui-bundle.tar", "satiui", "正在解压应用资源 (2/3)");
    const extractSatiMain = () =>
      this.ensureBundleExtracted(
        resources,
        runtimeBaseDir,
        "sati-main-bundle.tar",
        "sati-main",
        "正在解压应用资源 (3/3)",
      );
    const [satiMemoryDir, satiUiDir, satiMainDir] =
      process.env.SATI_TAR_PARALLEL === "0"
        ? [await extractMemoryCore(), await extractSatiUi(), await extractSatiMain()]
        : await Promise.all([extractMemoryCore(), extractSatiUi(), extractSatiMain()]);

    // ui/server/ files import compiled JS via relative paths like
    // `../../dist/src/pilot/index.js`. From satiui/server/ that
    // resolves to <runtimeBaseDir>/dist/src/..., but the actual dist/
    // tree lives inside <runtimeBaseDir>/sati-main/dist/. A symlink
    // bridges the gap so all ESM resolve calls succeed at runtime.
    const distLink = path.join(runtimeBaseDir, "dist");
    const distTarget = path.join(satiMainDir, "dist");
    linkDirectory(distLink, distTarget);

    // edgeclaw-memory-core is a file: dependency in the repo's package.json.
    // The release tar excludes the top-level edgeclaw-memory-core/ (it has
    // its own bundle), which also strips the node_modules/ symlink.
    // Compiled code does `import ... from "edgeclaw-memory-core"` (bare
    // specifier), so Node must find it under sati-main/node_modules/.
    const memNodeModLink = path.join(satiMainDir, "node_modules", "edgeclaw-memory-core");
    linkDirectory(memNodeModLink, satiMemoryDir);

    // npm hoists shared deps (ws, express, etc.) into the root node_modules/
    // which ends up inside sati-main-bundle.tar, not satiui-bundle.tar.
    // ESM resolution walks up the directory tree looking for node_modules/ dirs.
    // A symlink at <runtimeBaseDir>/node_modules → sati-main/node_modules
    // lets the resolver find hoisted packages after exhausting satiui's own.
    const hoistedLink = path.join(runtimeBaseDir, "node_modules");
    const hoistedTarget = path.join(satiMainDir, "node_modules");
    linkDirectory(hoistedLink, hoistedTarget);

    // ui/server/ also imports `../../src/web/server/*.js` etc. In dev
    // mode tsx resolves .js → .ts; in packaged mode we need actual .js
    // files. Point src/ → sati-main/dist/src/ (compiled output).
    const srcLink = path.join(runtimeBaseDir, "src");
    const srcTarget = path.join(satiMainDir, "dist", "src");
    linkDirectory(srcLink, srcTarget);

    // satiui/server/routes/memory.js imports edgeclaw-memory-core
    // via `../../../src/context/memory/edgeclaw-memory-core/lib/index.js`.
    // The src/ symlink points to sati-main/dist/src/ (compiled TS),
    // which contains an empty edgeclaw-memory-core/src/ stub (no lib/).
    // Replace that stub with a symlink to the real extracted bundle.
    const memSrcLink = path.join(runtimeBaseDir, "src", "context", "memory", "edgeclaw-memory-core");
    if (fsSync.existsSync(memSrcLink) && !fsSync.lstatSync(memSrcLink).isSymbolicLink()) {
      fsSync.rmSync(memSrcLink, { recursive: true });
    }
    linkDirectory(memSrcLink, satiMemoryDir);

    return {
      nodeBin: bundledBinary(path.join(resources, "node-bin"), "node"),
      bunBin: bundledBinary(path.join(resources, "bun-bin"), "bun"),
      serverEntry: path.join(satiUiDir, "server", "index.js"),
      serverCwd: satiUiDir,
      satiMainDir,
    };
  }

  // ───────────────────────── Orphan-process cleanup ───────────────────────
  //
  // The gateway child (spawned below) can outlive the Electron main process
  // when the app is force-killed (kill -9 / Activity Monitor). We clean up
  // in two places:
  //   • before each spawn (`cleanupOrphanRuntimeProcesses`) so a fresh start
  //     never silently reuses a stale upstream
  //   • after `stop()` so quitting Electron leaves no background processes
  //
  // Strategy: probe the gateway port for whoever is listening, verify the
  // process is really a Sati runtime process (isSatiRuntimeProcess), then
  // SIGTERM with a short grace period before SIGKILL.
  //
  // NOTE: the old cron-daemon socket/proxy (PROXY_PORT 18080) cleanup paths
  // were removed — the cron daemon no longer exists in the repo
  // (src/daemon was deleted, ui/server never spawns it) and the HTTP proxy
  // became an in-process undici dispatcher (src/cli/proxy.ts
  // installGlobalProxy), so nothing binds 18080 anymore.

  private async listenerPidForPort(port: number): Promise<number | null> {
    try {
      if (process.platform === "win32") {
        // netstat -ano gives lines like:  TCP  0.0.0.0:18790  0.0.0.0:0  LISTENING  1234
        // async execFile 避免 netstat 阻塞 Electron 主进程（与 lsof 分支一致）。
        const { stdout } = await execFile("netstat", ["-ano", "-p", "TCP"], { timeout: 5000 });
        const line = stdout.split("\n").find(l => l.includes("LISTENING") && l.includes(`:${port} `));
        if (!line) return null;
        const parts = line.trim().split(/\s+/);
        const pid = Number.parseInt(parts[parts.length - 1] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
      // async execFile 避免 lsof 阻塞 Electron 主进程（最坏 3s）。
      const { stdout } = await execFile("/usr/sbin/lsof", ["-nP", "-t", "-i", `:${port}`, "-sTCP:LISTEN"], {
        timeout: 3000,
      });
      const out = stdout.trim();
      if (!out) return null;
      const first = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(first) && first > 0 ? first : null;
    } catch {
      return null;
    }
  }

  private async cleanupOrphanRuntimeProcesses(): Promise<void> {
    await this.killOrphanGateway();
  }

  private async killOrphanGateway(): Promise<void> {
    // 直接用 lsof 查监听者（lsof 匹配任意地址族，含 IPv6/非 loopback；
    // 不用 portIsListening 预检——它仅探测 127.0.0.1，会漏掉此类孤儿进程）。
    const pid = await this.listenerPidForPort(GATEWAY_PORT);
    if (pid === null) return;
    if (pid === process.pid) return;
    // 端口可能被用户的无关进程占用，杀前验证 Sati 身份
    if (!(await isSatiRuntimeProcess(pid))) return;
    await killPidGracefully(pid, ORPHAN_TERM_WAIT_MS);
  }

  /**
   * 兜底：确保 gateway 端口可用。
   *
   * killOrphanGateway 只杀 Sati 运行时进程；若端口被非 Sati 进程占用（例如
   * 残留的旧 gateway 未被识别、或用户手动启动了同端口服务），gateway spawn 会
   * 抛 EADDRINUSE，sati-bridge 随即连接到该残留 listener 产生握手失败。
   *
   * 本方法在 killOrphanGateway 之后调用：若端口仍被占，无论占用者身份，
   * 统一尝试优雅终止，最多等待 ORPHAN_TERM_WAIT_MS 后强杀。
   */
  private async ensurePortFreeForGateway(port: number): Promise<void> {
    const pid = await this.listenerPidForPort(port);
    if (pid === null) return;
    if (pid === process.pid) return;
    // 已经是 Sati 进程 — killOrphanGateway 应该已处理；若仍存活则兜底杀
    await killPidGracefully(pid, ORPHAN_TERM_WAIT_MS);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, STABLE_RUN_RESET_MS);
  }

  /**
   * 调度一次重启（含连环崩溃续调度；restartAttempts 达到上限时触发 max-restarts）。
   * 返回 true 表示本次已真正调度（调用方据此决定是否清除 restartInFlight）。
   */
  private scheduleRestart(): boolean {
    if (this.stopRequested || this.initialStartInFlight || this.restartInFlight) return false;
    if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
      this.emit("max-restarts");
      this.port = null;
      return false;
    }

    const attempt = this.restartAttempts + 1;
    this.port = null; // 重启期间旧端口已死，先清空避免 IPC 返回死端口
    this.emit("restarting", attempt);
    const delay =
      RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)] ??
      RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];

    this.restartInFlight = true;
    void (async () => {
      let rescheduled = false;
      try {
        await sleep(delay);
        if (this.stopRequested) return; // finally 中清除 restartInFlight
        this.restartAttempts = attempt;
        const { port } = await this.startProcessAndWaitReady();
        this.port = port;
        this.emit("ready", port);
        this.scheduleStableReset();
      } catch (e: unknown) {
        // stop() 期间的失败：不报错不续调度（退出中的 app 不应弹错误框）。
        if (this.stopRequested) return;
        // 本次重启的 child 也未存活：报错并续调度下一轮重试。
        // 先清 restartInFlight 再续调度（续调度内部会重新置 true），
        // finally 中不得再 clobber —— 见下方 rescheduled 判定。
        this.emit("error", e instanceof Error ? e : new Error(String(e)));
        this.port = null;
        this.restartInFlight = false;
        rescheduled = this.scheduleRestart();
      } finally {
        // 仅当本次尝试没有续调度下一轮时清除（catch 中 scheduleRestart()
        // 刚设置的 restartInFlight=true 不能被 clobber，否则并发重启会
        // 双 spawn 抢同一端口）。成功/stop 路径同样在此清除。
        if (!rescheduled) this.restartInFlight = false;
      }
    })();
    return true;
  }

  private attachExitWatchdog(): void {
    if (!this.child || this.exitHandlerBound) return;
    this.exitHandlerBound = true;
    this.child.once("exit", (code, signal) => {
      this.exitHandlerBound = false;
      this.child = null;
      this.clearStableTimer();

      if (this.stopRequested) return;

      // While the very first start is still pending, let the outer
      // startProcessAndWaitReady -> waitForServerHealth() short-circuit
      // path surface the failure (it already collects the log tail and
      // throws via start() -> caller). Skipping watchdog work here keeps
      // us from emitting a duplicate "error" event before the caller's
      // try/catch attaches its handler, and from spawning concurrent
      // restart attempts that race the still-pending health poll loop.
      if (this.initialStartInFlight) return;

      // 重启任务的 spawn 流程仍在进行中：其 waitForServerHealth fast-fail
      // 会清理子进程并在 catch 中报错+续调度，这里直接跳过避免并发重启
      // 与 error 双发（restartAttempts 双计）。
      if (this.restartInFlight) return;

      const err = new Error(`Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`);
      this.emit("error", err);
      this.scheduleRestart();
    });
  }

  private async writePidFile(pid: number): Promise<void> {
    await ensureSatiDir();
    await fs.writeFile(getPidFilePath(), `${pid}\n`, "utf8");
  }

  private async removePidFile(): Promise<void> {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async startProcessAndWaitReady(): Promise<{ port: number }> {
    await cleanupStaleOrOrphanPid();
    // Kill leftover proxy/cron-daemon from a previous (crashed or
    // SIGKILL'd-by-Activity-Monitor) run. ensureSatiProxyRunning() in the
    // ui server otherwise short-circuits when port 18080 is occupied and
    // never gets a chance to attach its stdout pipe, so logs from the stale
    // proxy never reach desktop.server.log.
    await this.cleanupOrphanRuntimeProcesses();

    const chosenPort = await pickAvailablePort();
    this.emit("progress", "配置运行环境…");
    const { nodeBin, bunBin, serverEntry, serverCwd, satiMainDir } = await this.resolvePaths();

    if (!fsSync.existsSync(nodeBin)) {
      throw new Error(`Bundled Node not found at ${nodeBin}`);
    }
    if (!fsSync.existsSync(serverEntry)) {
      throw new Error(`Server entry not found at ${serverEntry}`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // 钉死数据目录并移除旧品牌变量：load-env.js 会把遗留的 PILOT_HOME
      // 映射为 SATI_HOME —— 若用户 shell 残留 PILOT_HOME 且 SATI_HOME 未设，
      // ui-server 子进程会读 ~/.pilotdeck 而 desktop/gateway 读 ~/.sati，
      // 三进程配置分歧导致 auth token 路径不匹配。显式钉死 + 删除旧变量
      // 保证三个子进程解析同一数据目录。
      SATI_HOME: getSatiDir(),
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      SATI_DESKTOP: "1",
      SERVER_PORT: String(chosenPort),
      // Keep satiui's sati-bridge in sync with the (possibly overridden)
      // gateway port. sati-bridge.js falls back to ws://127.0.0.1:19789/ws
      // when this env var is absent.
      SATI_GATEWAY_URL: `ws://127.0.0.1:${GATEWAY_PORT}/ws`,
      // Force loopback regardless of what runtime.host says in YAML.
      // satiui's buildRuntimeEnv now respects pre-set env vars.
      HOST: "127.0.0.1",
      // Ensure spawned `bun` subprocess (sati-main cli.tsx) finds the bundled bun
      BUN_BIN: bunBin,
      // Tell satiui where sati-main lives
      SATI_MAIN_DIR: satiMainDir,
      // Prepend bundled Node + Bun to PATH so any indirect lookups resolve our binaries
      PATH: `${path.dirname(nodeBin)}${path.delimiter}${path.dirname(bunBin)}${path.delimiter}${
        process.env.PATH ?? ""
      }`,
      // Reasoning-friendly default. Anything already present (env passthrough
      // from launchctl, user shell, or buildRuntimeEnv() reading
      // agents.main.params.maxOutputTokens) wins via the spread above… except
      // process.env doesn't normally carry this var, so this default applies
      // unless overridden. See REASONING_FRIENDLY_MAX_OUTPUT_TOKENS docstring.
      SATI_MAX_OUTPUT_TOKENS: process.env.SATI_MAX_OUTPUT_TOKENS ?? REASONING_FRIENDLY_MAX_OUTPUT_TOKENS,
    };
    // 移除旧品牌变量（见上方 SATI_HOME 注释）：显式 delete 比依赖
    // spawn 对 undefined 值的过滤更明确。
    delete env.PILOT_HOME;
    delete env.PILOTDECK_CONFIG_PATH;
    delete env.PILOTDECK_PORT;

    // Mirror server stdout/stderr to <SATI_HOME>/desktop.server.log so
    // failures are diagnosable even when the user launches via Finder/Dock
    // (no terminal).
    await ensureSatiDir();
    const logPath = getServerLogPath();

    // --- Start the Gateway process before the UI server ---
    // The UI server's sati-bridge connects to the gateway WebSocket at
    // ${GATEWAY_PORT} (via SATI_GATEWAY_URL injected below) within 30s. We
    // must have the gateway listening before the UI server attempts its
    // first WebSocket handshake.
    //
    // Before spawning, ensure GATEWAY_PORT is free. The orphan cleanup
    // above (cleanupOrphanRuntimeProcesses) only kills processes identified
    // as Sati runtime — a non-Sati process holding the port would survive.
    // If we blindly spawn into an occupied port, gateway dies with
    // EADDRINUSE and sati-bridge connects to the stale listener, producing
    // the "invalid request frame" handshake error.
    await this.ensurePortFreeForGateway(GATEWAY_PORT);

    const gatewayEntry = path.join(satiMainDir, "dist", "src", "cli", "sati.js");
    if (fsSync.existsSync(gatewayEntry)) {
      this.emit("progress", "启动正念智能体 Gateway…");
      // 同实例重启路径：先清上一次 spawn 的 gateway 引用（按端口探测的
      // killOrphanGateway 依赖 isSatiRuntimeProcess，此处按引用直接杀最稳）。
      if (this.gatewayChild) {
        await this.killProcessGracefully(this.gatewayChild, ORPHAN_TERM_WAIT_MS);
        this.gatewayChild = null;
      }
      const { child: gwChild, endLog: endGwLog } = spawnWithLog([nodeBin, gatewayEntry, "server"], {
        cwd: satiMainDir,
        env: {
          ...env,
          SATI_GATEWAY_PORT: String(GATEWAY_PORT),
        },
        logPath,
        header: `(gateway port=${GATEWAY_PORT})`,
      });
      // 异步 spawn 失败（EACCES/丢失 exec bit/缺 dylib）若不监听会以
      // unhandled 'error' 事件直接崩溃 Electron 主进程。
      // 用数组承载错误：TS CFA 不追踪闭包内对 let 的赋值（会窄化成 never）。
      const gwSpawnErrors: Error[] = [];
      gwChild.once("error", err => {
        gwSpawnErrors.push(err);
      });
      this.gatewayChild = gwChild;

      // Wait for gateway to start listening（net 连接探测，避免每轮 execSync lsof 阻塞主线程）
      const gwDeadline = Date.now() + GATEWAY_STARTUP_TIMEOUT_MS;
      let gwReady = false;
      while (Date.now() < gwDeadline) {
        // exitCode/signalCode/spawn 错误任一命中即快速失败，不烧满 45s
        if (gwChild.exitCode !== null || gwChild.signalCode !== null || gwSpawnErrors.length > 0) break;
        if (await portIsListening(GATEWAY_PORT)) {
          gwReady = true;
          break;
        }
        await sleep(HEALTH_POLL_MS);
      }
      if (!gwReady) {
        // SIGTERM → 轮询退出 → SIGKILL 兜底（挂死的 gateway 不应泄漏 fd/管道）
        await this.killProcessGracefully(gwChild, ORPHAN_TERM_WAIT_MS);
        this.gatewayChild = null;
        endGwLog();
        const tail = readTailSafe(logPath, 4000);
        const reason = gwSpawnErrors[0]
          ? `spawn error: ${gwSpawnErrors[0].message}`
          : `not listening within ${GATEWAY_STARTUP_TIMEOUT_MS}ms`;
        throw new Error(`Gateway failed to start on port ${GATEWAY_PORT} (${reason})\n--- log tail ---\n${tail}`);
      }
    }

    const { child, endLog } = spawnWithLog([nodeBin, serverEntry], {
      cwd: serverCwd,
      env,
      logPath,
      header: `(port=${chosenPort})`,
    });
    const serverSpawnErrors: Error[] = [];
    child.once("error", err => {
      serverSpawnErrors.push(err);
      endLog();
    });

    if (!child.pid || serverSpawnErrors.length > 0) {
      endLog();
      throw new Error(
        `Failed to spawn server process${serverSpawnErrors[0] ? `: ${serverSpawnErrors[0].message}` : ""}`,
      );
    }

    this.serverLogEnd = endLog;
    this.child = child;
    this.exitHandlerBound = false;
    this.attachExitWatchdog();

    await this.writePidFile(child.pid);

    this.emit("progress", "启动本地服务…");
    try {
      await waitForServerHealth(chosenPort, child);
    } catch (err) {
      // 失败清理：server 与 gateway 都要杀（gateway 已起的场景，
      // 不清理会让下一轮 spawn 撞上 EADDRINUSE）。
      await this.killChildGracefully();
      await this.killGatewayGracefully();
      this.child = null;
      this.gatewayChild = null;
      await this.removePidFile();
      // stop() 期间的失败不报错（退出中的 app 不应弹错误框），由 stop()
      // 自身流程收尾。
      if (this.stopRequested) {
        throw new Error("Server start cancelled by stop()");
      }
      const tail = readTailSafe(logPath, 4000);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n--- server log tail (${logPath}) ---\n${tail}`,
      );
    }

    // health 通过后、返回前复查 stop()：收窄"stop() 与重启 IIFE 竞态"窗口
    // —— stop() 可能恰在本函数 spawn 期间执行完毕，新起的进程必须被回收。
    if (this.stopRequested) {
      await this.killChildGracefully();
      await this.killGatewayGracefully();
      this.child = null;
      this.gatewayChild = null;
      await this.removePidFile();
      throw new Error("Server start cancelled by stop()");
    }

    return { port: chosenPort };
  }

  /** 统一优雅终止：SIGTERM → 轮询退出 → SIGKILL（child 与 gateway 共用）。 */
  private async killProcessGracefully(proc: ChildProcess | null, waitMs: number): Promise<void> {
    if (!proc || !proc.pid) return;
    await killPidGracefully(proc.pid, waitMs);
  }

  private async killChildGracefully(): Promise<void> {
    await this.killProcessGracefully(this.child, SHUTDOWN_SIGTERM_WAIT_MS);
  }

  start(): Promise<{ port: number }> {
    if (this.startPromise) return this.startPromise;

    this.stopRequested = false;
    this.restartAttempts = 0;
    this.restartInFlight = false; // stop() 早退可能留下 stale true，start 时复位
    this.initialStartInFlight = true;

    this.startPromise = (async () => {
      try {
        const { port } = await this.startProcessAndWaitReady();
        this.port = port;
        this.initialStartInFlight = false;
        this.emit("ready", port);
        this.scheduleStableReset();
        return { port };
      } catch (e: unknown) {
        this.initialStartInFlight = false;
        const err = e instanceof Error ? e : new Error(String(e));
        this.emit("error", err);
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearStableTimer();
    // 移除 exit watchdog（防止退出过程中的 exit 事件触发重启调度）。
    // 注意：这也会移除 spawnWithLog 注册的"exit → endLog"监听，因此
    // 必须手动 end 日志流，否则 fd 泄漏且子进程最后几行日志丢失。
    this.child?.removeAllListeners("exit");
    this.serverLogEnd?.();
    this.serverLogEnd = null;

    await this.killChildGracefully();
    this.child = null;
    this.port = null;

    // Stop the gateway process
    await this.killGatewayGracefully();
    this.gatewayChild = null;

    await this.removePidFile();
    // As a belt-and-suspenders safety net — in case the parent died via
    // SIGKILL, hung past the SIGTERM grace, or the user used `kill -9` from
    // Activity Monitor — sweep any remaining orphan gateway so quitting Sati
    // really leaves zero processes.
    await this.cleanupOrphanRuntimeProcesses();
    // stopRequested 保持 true 直到下一次显式 start() 重置，避免退出竞态
    // （IIFE 的 post-sleep 检查依赖它）。
  }

  private async killGatewayGracefully(): Promise<void> {
    await this.killProcessGracefully(this.gatewayChild, SHUTDOWN_SIGTERM_WAIT_MS);
  }

  getPort(): number | null {
    return this.port;
  }

  isRunning(): boolean {
    const c = this.child;
    return c !== null && c.exitCode === null && c.signalCode === null;
  }
}
