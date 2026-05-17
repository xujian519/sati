import type { PilotDeckToolDefinition } from "../protocol/types.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import { NodeShellCommandRunner, type PilotDeckCommandRunner } from "./bash/commandRunner.js";
import { classifyBashPermission, isReadOnlyShellCommand } from "./bash/permissions.js";

export type BashInput = {
  command?: string;
  timeoutMs?: number;
  description?: string;
};

export type CreateBashToolOptions = {
  runner?: PilotDeckCommandRunner;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

export function createBashTool(options?: CreateBashToolOptions): PilotDeckToolDefinition<BashInput> {
  const runner = options?.runner ?? new NodeShellCommandRunner();
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options?.maxTimeoutMs ?? 600_000;

  return {
    name: "bash",
    aliases: ["Bash"],
    description: "Run a shell command in the PilotDeck workspace. Returns stdout/stderr and exit code.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: [],
      additionalProperties: false,
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute (passed to /bin/sh -c).",
        },
        timeoutMs: {
          type: "integer",
          description: "Timeout in milliseconds. Defaults to 30000. Max 600000.",
        },
        description: {
          type: "string",
          description: "Short human-readable label for audit logs (3-10 words).",
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => !input.command || isReadOnlyShellCommand(input.command),
    isOpenWorld: () => true,
    checkPermissions: async (input) => input.command ? classifyBashPermission(input.command) : ({ type: "allow" as const, reason: { type: "runtime" as const, message: "Empty command is safe" } }),
    execute: async (input, context) => {
      const command = (input.command ?? "").trim();
      if (!command) {
        return {
          content: [{ type: "text", text: "No command provided. The shell executed nothing.\nIf you intended to run a command, provide a non-empty `command` parameter.\nIf you have nothing to run, respond with text instead of calling bash." }],
          data: { command: "", exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 0 },
        };
      }
      const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? defaultTimeoutMs), maxTimeoutMs);
      const progress = context.progress;
      const toolCallId = ""; // ToolRuntime fills this via metadata; we pull from context if available.
      const emitProgress = progress
        ? (stream: "stdout" | "stderr") => (chunk: string) => {
            try {
              progress({
                type: "tool_progress",
                sessionId: context.sessionId,
                turnId: context.turnId,
                toolCallId,
                toolName: "bash",
                message: `${stream}: ${chunk.length} bytes`,
                metadata: { stream, chunk, byteCount: Buffer.byteLength(chunk, "utf8") },
                createdAt: (context.now?.() ?? new Date()).toISOString(),
              });
            } catch {
              // Progress sinks are fire-and-forget; never crash the tool.
            }
          }
        : undefined;
      const result = await runner.run(command, {
        cwd: context.cwd,
        env: context.env,
        timeoutMs,
        signal: context.abortSignal,
        onStdout: emitProgress?.("stdout"),
        onStderr: emitProgress?.("stderr"),
      });

      if (result.timedOut) {
        throw new PilotDeckToolRuntimeError("tool_timeout", `Command timed out after ${timeoutMs}ms.`);
      }

      if (result.exitCode !== 0) {
        const summary = formatShellFailure(command, result);
        throw new PilotDeckToolRuntimeError("tool_execution_failed", summary, {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: formatShellResult(result.stdout, result.stderr, result.exitCode),
          },
        ],
        data: {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
        },
      };
    },
  };
}

function formatShellResult(stdout: string, stderr: string, exitCode: number | null): string {
  const parts: string[] = [];
  if (stdout.length > 0) {
    parts.push(stdout);
  }
  if (stderr.length > 0) {
    parts.push(stderr);
  }
  return parts.length > 0 ? parts.join("\n") : `exitCode: ${exitCode ?? "null"}`;
}

function formatShellFailure(
  command: string,
  result: { exitCode: number | null; stdout: string; stderr: string },
): string {
  const lines: string[] = [];
  lines.push(`Command exited with code ${result.exitCode ?? "null"}: ${command}`);
  if (result.stderr.length > 0) {
    lines.push("", "stderr:", result.stderr.trimEnd());
  }
  if (result.stdout.length > 0) {
    lines.push("", "stdout:", result.stdout.trimEnd());
  }
  return lines.join("\n");
}

export type { PilotDeckCommandOptions, PilotDeckCommandResult, PilotDeckCommandRunner } from "./bash/commandRunner.js";
