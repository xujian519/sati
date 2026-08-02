/**
 * `ego_browser` builtin tool — drives the ego-browser CLI (provided by the
 * ego lite app) so Sati agents can run a real Chromium browser for pages that
 * need JavaScript rendering, login state, or anti-bot handling.
 *
 * The tool passes a Node.js script (the heredoc body of `ego-browser nodejs`)
 * straight through to the CLI. ego-browser task spaces inherit the user's ego
 * lite login state by default, so authenticated sites are reachable without
 * re-entering credentials.
 */

import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PermissionResult } from "../../permission/index.js";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolValidationResult } from "../protocol/schema.js";
import type {
  SatiToolAvailability,
  SatiToolAvailabilityContext,
  SatiToolDefinition,
  SatiToolExecutionOutput,
} from "../protocol/types.js";
import { NodeShellCommandRunner, type SatiCommandResult, type SatiCommandRunner } from "./bash/commandRunner.js";

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
};

const DEFAULT_COMMAND_NAME = "ego-browser";
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const MAX_SCRIPT_LENGTH = 50_000;
const HEREDOC_MARKER = "EGO_SCRIPT_EOF";

const EGO_BROWSER_DESCRIPTION = `Drive the ego-browser (ego lite) real Chromium browser from inside Sati. Use this for pages that need JavaScript rendering, login state, or anti-bot handling — e.g. Google Patents, CNIPA, Baidu Patents, authenticated databases, or interactive web UIs. Prefer this over web_fetch/web_search when a site blocks plain HTTP requests or requires the user's logged-in session.

Input \`script\` is a Node.js program run by \`ego-browser nodejs\` (the body of a heredoc). All ego-browser helpers are preloaded; print the final result with \`cliLog(...)\` — only \`cliLog\` output is returned to you.

Core helpers:
- Task spaces: \`useOrCreateTaskSpace(name)\` (returns task), \`completeTaskSpace(id, { keep: false })\`, \`listTaskSpaces\`
- Navigation: \`openOrReuseTab(url, { wait: true, timeout: 30 })\`, \`gotoAndWait\`, \`pageInfo()\`, \`snapshotText()\` (semantic tree with refs/locators)
- Interaction: \`click('@N' | css | loc=...)\`, \`fillInput\`, \`typeText\`, \`pressKey\`, \`scrollBy\`, \`uploadFile\`
- Evaluate: \`js('(() => {...})()')\` (runs in the page), \`cdp(...)\`, \`serverFetch\`, \`browserFetch\`
- Output: \`cliLog(value)\` — the only way to return data; \`help(name)\` prints usage

Task spaces default to inheriting the user's ego lite login state, so authenticated sites work without re-entering credentials. Reuse the same task space name across calls for a continuous session; always finish with \`completeTaskSpace(id, { keep: false })\` unless the user needs the page left open.

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
  const runner = options.runner ?? new NodeShellCommandRunner();

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
    checkAvailability: (context): SatiToolAvailability => {
      const platform = options.platform ?? process.platform;
      if (platform !== "darwin") {
        return {
          ok: false,
          code: "unavailable",
          reason: "ego-browser (ego lite) only supports macOS.",
        };
      }
      if (!isEgoBrowserCommandAvailable(options.homeDir ?? homedir(), context)) {
        return {
          ok: false,
          code: "setup_required",
          reason:
            "ego-browser CLI not found. Install ego lite (https://lite.ego.app/), complete first-run onboarding, and confirm `ego-browser` is on the PATH (usually ~/.local/bin/ego-browser).",
        };
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
      if (script.includes(`\n${HEREDOC_MARKER}`)) {
        return {
          ok: false,
          issues: [
            {
              path: "script",
              code: "invalid_schema",
              message: `script must not contain the heredoc marker "${HEREDOC_MARKER}"`,
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
      const command = buildEgoBrowserCommand(commandName, input.script);
      const env = buildEgoBrowserEnv(context.env ?? process.env, options.homeDir ?? homedir(), options.pathEntries);

      let result: SatiCommandResult;
      try {
        result = await runner.run(command, {
          cwd: context.cwd,
          env,
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
      // is empty in practice.
      const combinedOutput = [result.stdout, result.stderr].filter(text => text.length > 0).join("\n");
      const output = truncateStdout(combinedOutput, maxOutputBytes);
      return {
        content: [{ type: "text", text: output }],
        data: {
          output,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          timedOut: false,
          durationMs: result.durationMs,
        },
        metadata: {
          command: commandName,
          durationMs: result.durationMs,
          outputBytes: output.length,
          outputChannel: result.stdout.length > 0 ? "stdout" : "stderr",
        },
      };
    },
  };
}

function buildEgoBrowserCommand(commandName: string, script: string): string {
  return `${commandName} nodejs <<'${HEREDOC_MARKER}'\n${script}\n${HEREDOC_MARKER}`;
}

function buildEgoBrowserEnv(
  base: NodeJS.ProcessEnv,
  homeDir: string,
  pathEntries: string[] | undefined,
): NodeJS.ProcessEnv {
  const entries = pathEntries ?? [join(homeDir, ".local", "bin")];
  const existingPath = base.PATH ?? "";
  const segments = existingPath.length > 0 ? existingPath.split(":") : [];
  for (const entry of entries) {
    if (entry && entry.length > 0 && !segments.includes(entry)) {
      segments.push(entry);
    }
  }
  return { ...base, PATH: segments.join(":") };
}

function isEgoBrowserCommandAvailable(homeDir: string, context: SatiToolAvailabilityContext): boolean {
  const localBin = join(homeDir, ".local", "bin");
  const pathSegments = (context.env?.PATH ?? process.env.PATH ?? "").split(":").filter(segment => segment.length > 0);
  const candidates = [
    join(localBin, DEFAULT_COMMAND_NAME),
    ...pathSegments.map(segment => join(segment, DEFAULT_COMMAND_NAME)),
  ];
  return candidates.some(isExecutableFile);
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function summarizeFailure(result: SatiCommandResult): string {
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

function truncateStdout(text: string, maxBytes: number): string {
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}…\n[output truncated]` : text;
}
