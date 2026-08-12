/**
 * `ego_browser` builtin tool — drives the ego-browser CLI (provided by the
 * ego lite app) so Sati agents can run a real Chromium browser for pages that
 * need JavaScript rendering, login state, or anti-bot handling.
 *
 * The tool passes a Node.js script (the heredoc body of `ego-browser nodejs`)
 * straight through to the CLI. ego-browser task spaces inherit the user's ego
 * lite login state by default, so authenticated sites are reachable without
 * re-entering credentials.
 *
 * 执行层统一委托 `EgoBrowserSession`（src/patent/data/nuo/egoSession.ts）：
 * heredoc 构造 / PATH 注入 / CLI 探测 / 输出截断的唯一 canonical 实现，
 * 本文件只保留工具定义与错误语义。
 */

import { EgoBrowserSession, EGO_HEREDOC_MARKER } from "../../patent/data/nuo/egoSession.js";
import type { PermissionResult } from "../../permission/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolValidationResult } from "../protocol/schema.js";
import type {
  SatiToolAvailability,
  SatiToolAvailabilityContext,
  SatiToolDefinition,
  SatiToolExecutionOutput,
} from "../protocol/types.js";
import type { SatiCommandRunner } from "./bash/commandRunner.js";

export type EgoBrowserInput = {
  /**
   * Node.js script executed inside the ego-browser runtime (the body of an
   * `ego-browser nodejs` heredoc). ego-browser helpers are preloaded:
   * `useOrCreateTaskSpace`, `openOrReuseTab`, `snapshotText`, `click`,
   * `fillInput`, `js`, `cliLog`, `completeTaskSpace`, and more. The final
   * result must be printed with `cliLog(...)`.
   */
  script: string;
  /** Override the execution timeout in milliseconds (default 90000, max 300000). */
  timeoutMs?: number;
};

export type EgoBrowserOutput = {
  /** Merged cliLog output (stdout + stderr; ego-browser prints cliLog to stderr). */
  output: string;
  /** Raw stdout channel. */
  stdout: string;
  /** Raw stderr channel. */
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
};

export type CreateEgoBrowserToolOptions = {
  /** Test seam: replace the underlying shell runner. */
  runner?: SatiCommandRunner;
  /** CLI command name (default "ego-browser"). */
  commandName?: string;
  /** Default execution timeout (default 90_000). */
  defaultTimeoutMs?: number;
  /** Hard cap for `timeoutMs` (default 300_000). */
  maxTimeoutMs?: number;
  /** Home directory used to locate `~/.local/bin` (default `os.homedir()`). */
  homeDir?: string;
  /** Platform override for tests (default `process.platform`). */
  platform?: NodeJS.Platform;
  /** Extra PATH entries, default `["<home>/.local/bin"]` (GUI-launched PATH often lacks it). */
  pathEntries?: string[];
  /** Soft cap on returned stdout bytes (default 200_000). */
  maxOutputBytes?: number;
  /**
   * When true, `checkAvailability` additionally runs a connection probe
   * (`ego-browser nodejs -e "cliLog(...)"`) to confirm the ego lite app is
   * actually reachable, not just that the CLI file exists. Default false —
   * the probe costs a process spawn on every availability check.
   */
  doctorCheck?: boolean;
  /** Timeout for the connection probe in ms (default 8_000). */
  doctorTimeoutMs?: number;
};

const DEFAULT_COMMAND_NAME = "ego-browser";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const DEFAULT_DOCTOR_TIMEOUT_MS = 8_000;
const MAX_SCRIPT_LENGTH = 50_000;

const EGO_BROWSER_DESCRIPTION = `Drive the ego-browser (ego lite) real Chromium browser from inside Sati. Use this for pages that need JavaScript rendering, login state, or anti-bot handling — e.g. Google Patents, CNIPA, Baidu Patents, authenticated databases, or interactive web UIs. Prefer this over web_fetch/web_search when a site blocks plain HTTP requests or requires the user's logged-in session.

Input \`script\` is a Node.js program run by \`ego-browser nodejs\` (the body of a heredoc). All ego-browser helpers are preloaded; print the final result with \`cliLog(...)\` — only \`cliLog\` output is returned to you.

Core helpers:
- Task spaces: \`useOrCreateTaskSpace(name)\` (returns task), \`completeTaskSpace(id, { keep: false })\`, \`listTaskSpaces\`
- Navigation: \`openOrReuseTab(url, { wait: true, timeout: 30 })\`, \`gotoAndWait\`, \`pageInfo()\`, \`snapshotText()\` (semantic tree with refs/locators)
- Interaction: \`click('@N' | css | loc=...)\`, \`fillInput\`, \`typeText\`, \`pressKey\`, \`scrollBy\`, \`uploadFile\`
- Evaluate: \`js('(() => {...})()')\` (runs in the page), \`cdp(...)\`, \`serverFetch\`, \`browserFetch\`
- Output: \`cliLog(value)\` — the only way to return data; \`help(name)\` prints usage

Playwright-style \`page\` facade (binds the current tab): \`page.goto(url)\`, \`page.url()\`, \`page.locator(css)\` / \`page.getByText(...)\`, \`page.waitForLoadState('load')\`, \`page.screenshot({ path })\`, \`page.waitForEvent('download')\` (returns { saveAs(path), url(), suggestedFilename() } — in-browser download interception, reuse it for PDF/file downloads instead of guessing CDN URLs), \`page.screencast.start({ path, size })\` / \`page.screencast.stop()\` (record the session for evidence), \`page.keyboard.press\`, \`page.mouse.click\`.

Learned site skills: \`site.runTool(siteId, toolName, args)\` runs a packaged site tool (e.g. google-patents) — see \`site.skills(url)\` to list what applies to a URL.

Parallel work: multiple task spaces run concurrently — create several spaces and \`await Promise.all([...])\` to scrape/search several sites at once; each space is isolated and inherits login state.

Task spaces default to inheriting the user's ego lite login state, so authenticated sites work without re-entering credentials. Reuse the same task space name across calls for a continuous session; always finish with \`completeTaskSpace(id, { keep: false })\` unless the user needs the page left open. If the browser connection seems stale, restart the ego lite app (newer CLI builds also offer \`ego-browser --doctor\` / \`--reload\`).

Example (Google Patents keyword search):
\`\`\`js
const task = await useOrCreateTaskSpace('patent search: pcm thermal');
await openOrReuseTab('https://patents.google.com/?q=phase+change+material+thermal+management', { wait: true, timeout: 30 });
await wait(5); // results render asynchronously
const results = await js(String.raw\`(() => {
  const seen = new Set(); const out = [];
  for (const a of document.querySelectorAll('a')) {
    const m = a.href && a.href.match(/patents\\.google\\.com\\/patent\\/([^/]+)/);
    if (m && !seen.has(m[1])) { seen.add(m[1]); out.push(m[1]); }
    if (out.length >= 10) break;
  }
  return out;
})()\`);
cliLog(JSON.stringify(results));
await completeTaskSpace(task.id, { keep: false });
\`\`\`

Notes:
- If the site needs a captcha or manual login, call \`handOffTaskSpace(id)\` and tell the user what to do, then resume with \`takeOverTaskSpace(id)\` after confirmation.
- Default timeout is 90000ms (navigation + rendering on slow sites); pass \`timeoutMs\` only when the script genuinely needs more, up to 300000ms.
- Keep scripts small and observable: navigate, wait for a visible signal, extract, report. Do not use browser automation as a general crawler.`;

export function createEgoBrowserTool(
  options: CreateEgoBrowserToolOptions = {},
): SatiToolDefinition<EgoBrowserInput, EgoBrowserOutput> {
  const commandName = options.commandName ?? DEFAULT_COMMAND_NAME;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxTimeoutMs = options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const session = new EgoBrowserSession({
    commandName,
    defaultTimeoutMs,
    maxTimeoutMs,
    homeDir: options.homeDir,
    pathEntries: options.pathEntries,
    maxOutputBytes,
    platform: options.platform,
    runner: options.runner,
  });

  return {
    name: "ego_browser",
    aliases: ["EgoBrowser"],
    description: EGO_BROWSER_DESCRIPTION,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["script"],
      additionalProperties: false,
      properties: {
        script: {
          type: "string",
          description:
            "Node.js program executed by `ego-browser nodejs` (heredoc body). Helpers are preloaded; print the result with cliLog(...).",
        },
        timeoutMs: {
          type: "integer",
          description: `Override execution timeout in milliseconds. Default ${defaultTimeoutMs}; max ${maxTimeoutMs}.`,
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    isOpenWorld: () => true,
    checkAvailability: async (context: SatiToolAvailabilityContext): Promise<SatiToolAvailability> => {
      const availability = session.checkAvailability(context.env);
      if (!availability.ok) {
        const platform = options.platform ?? process.platform;
        return {
          ...availability,
          reason: buildEgoUnavailableReason(platform, availability.code),
        };
      }
      if (options.doctorCheck) {
        const doctorOk = await session.runConnectionProbe(options.doctorTimeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS);
        if (!doctorOk) {
          return {
            ok: false,
            code: "failed_check",
            reason:
              "ego-browser CLI is present but the browser connection could not be confirmed — the ego lite app may not be running or this CLI version does not support the probe. Launch ego lite and retry; if it persists, run `ego-browser upgrade` or reinstall from https://lite.ego.app/.",
          };
        }
      }
      return { ok: true };
    },
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "ego_browser",
        message: "Driving the user's ego-browser (ego lite) requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "ego_browser",
        inputSummary: "browser automation",
        reason: {
          type: "tool",
          toolName: "ego_browser",
          message: "Driving the user's ego-browser (ego lite) requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow browser automation" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    validateInput: async (input): Promise<SatiToolValidationResult> => {
      if (!input || typeof input !== "object") {
        return {
          ok: false,
          issues: [{ path: "", code: "invalid_type", message: "input must be an object" }],
        };
      }
      const { script, timeoutMs } = input as Partial<EgoBrowserInput>;
      if (typeof script !== "string" || script.trim().length === 0) {
        return {
          ok: false,
          issues: [{ path: "script", code: "required", message: "script is required" }],
        };
      }
      if (script.length > MAX_SCRIPT_LENGTH) {
        return {
          ok: false,
          issues: [
            {
              path: "script",
              code: "invalid_schema",
              message: `script exceeds the maximum length of ${MAX_SCRIPT_LENGTH} characters`,
            },
          ],
        };
      }
      if (script.includes(`\n${EGO_HEREDOC_MARKER}`)) {
        return {
          ok: false,
          issues: [
            {
              path: "script",
              code: "invalid_schema",
              message: `script must not contain the heredoc marker "${EGO_HEREDOC_MARKER}"`,
            },
          ],
        };
      }
      if (timeoutMs !== undefined) {
        if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maxTimeoutMs) {
          return {
            ok: false,
            issues: [
              {
                path: "timeoutMs",
                code: "invalid_schema",
                message: `timeoutMs must be an integer between 1 and ${maxTimeoutMs}`,
              },
            ],
          };
        }
      }
      return { ok: true, input };
    },
    execute: async (input, context): Promise<SatiToolExecutionOutput<EgoBrowserOutput>> => {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs;
      let result;
      try {
        result = await session.runScript(input.script, {
          cwd: context.cwd,
          env: context.env ?? process.env,
          timeoutMs,
          signal: context.abortSignal,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SatiToolRuntimeError("tool_execution_failed", `ego_browser failed to start: ${message}`, {
          command: commandName,
        });
      }

      if (result.timedOut) {
        throw new SatiToolRuntimeError(
          "tool_timeout",
          `ego_browser timed out after ${timeoutMs}ms. The script may be waiting on a slow page, a dialog, or user control (handOffTaskSpace). Retry with a targeted script, a longer timeoutMs, or ask the user to take over the browser.`,
          { durationMs: result.durationMs },
        );
      }
      if (result.exitCode !== 0) {
        const detail = summarizeFailure(result);
        throw new SatiToolRuntimeError(
          "tool_execution_failed",
          `ego_browser exited with code ${result.exitCode}. ${detail}`,
          { exitCode: result.exitCode, stderr: result.stderr.slice(0, 2_000) },
        );
      }

      // ego-browser prints `cliLog(...)` output to stderr (observed on
      // v0.4.5.8), so the tool result must merge both channels — stdout alone
      // is empty in practice. `result.output` is already the merged, truncated
      // text from the session.
      return {
        content: [{ type: "text", text: result.output }],
        data: {
          output: result.output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: false,
          durationMs: result.durationMs,
        },
        metadata: {
          command: commandName,
          durationMs: result.durationMs,
          outputBytes: result.output.length,
          outputChannel: result.stdout.length > 0 ? "stdout" : "stderr",
        },
      };
    },
  };
}

function summarizeFailure(result: { stdout: string; stderr: string }): string {
  const stderr = result.stderr.trim();
  if (stderr.length > 0) {
    return stderr.length > 1_000 ? `stderr: ${stderr.slice(0, 1_000)}…` : `stderr: ${stderr}`;
  }
  const stdout = result.stdout.trim();
  if (stdout.length > 0) {
    return stdout.length > 1_000 ? `stdout: ${stdout.slice(0, 1_000)}…` : `stdout: ${stdout}`;
  }
  return "No output captured.";
}

/**
 * 三平台差异化的 ego 不可用提示（级联降级指引）。
 * 与 docs/windows-browser-automation-plan.md §5.2.3 保持一致：
 * macOS 走「安装/启动 ego lite + 备选链」，Windows/Linux 直接给备选链。
 */
function buildEgoUnavailableReason(platform: NodeJS.Platform, code: "unavailable" | "setup_required"): string {
  const fallback = [
    "可用替代方案（按体验排序）：",
    "  1. BrowserOS neo (https://browseros.com/agents) — 第二浏览器，Chrome 登录态一键导入 + 录屏回放",
    "  2. browser-use CLI — MIT 协议，三端一致（见下方安装命令）",
    "  3. Sati 内置 @playwright/mcp — 无需额外安装，公开页面可用（无已登录会话）",
    "运行 `sati browsers` 查看本机浏览器后端探测矩阵。",
  ].join("\n");

  if (platform === "darwin") {
    if (code === "setup_required") {
      return [
        "ego-browser CLI not found. Install ego lite (https://lite.ego.app/), complete first-run onboarding, and confirm `ego-browser` is on the PATH (usually ~/.local/bin/ego-browser).",
        fallback,
        "  (macOS 备选安装：brew install uv && uv tool install browser-use)",
      ].join("\n");
    }
    return [
      "ego-browser (ego lite) is unavailable on this macOS machine. Launch the ego lite app and retry; if the browser session stays stale, restart ego lite or run `ego-browser --doctor` / `--reload`.",
      fallback,
    ].join("\n");
  }

  if (platform === "win32") {
    return [
      "ego-browser (ego lite) does not support Windows.",
      "  1. BrowserOS neo (https://browseros.com/agents) — 下载 .exe，Chrome 登录态一键导入 + 录屏回放，Windows 体验最佳",
      "  2. browser-use CLI — winget install Python.Python.3.12 && uv tool install browser-use",
      "  3. Sati 内置 @playwright/mcp — 无需额外安装，公开页面可用（无已登录会话）",
      "运行 `sati browsers` 查看本机浏览器后端探测矩阵。",
    ].join("\n");
  }

  if (platform === "linux") {
    return [
      "ego-browser (ego lite) does not support Linux.",
      "  1. browser-use CLI — 安装 uv（apt|yum|pacman install uv）后执行 uv tool install browser-use；MIT 协议，Linux 首选",
      "  2. Sati 内置 @playwright/mcp — 无需额外安装，公开页面可用（无已登录会话）",
      "注：BrowserOS neo 暂不支持 Linux；完整录屏与登录态管理可关注 BrowserOS（非 neo）的 AppImage/Deb 包。",
      "运行 `sati browsers` 查看本机浏览器后端探测矩阵。",
    ].join("\n");
  }

  return ["ego-browser (ego lite) only supports macOS.", fallback].join("\n");
}
