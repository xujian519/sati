import type { PolitDeckToolDefinition } from "../protocol/types.js";
import { PolitDeckToolRuntimeError } from "../protocol/errors.js";
import { NodeShellCommandRunner, type PolitDeckCommandRunner } from "./bash/commandRunner.js";
import { classifyBashPermission, isReadOnlyShellCommand } from "./bash/permissions.js";

export type BashInput = {
  command: string;
  timeoutMs?: number;
  description?: string;
};

export type CreateBashToolOptions = {
  runner?: PolitDeckCommandRunner;
  defaultTimeoutMs?: number;
  maxTimeoutMs?: number;
};

export function createBashTool(options?: CreateBashToolOptions): PolitDeckToolDefinition<BashInput> {
  const runner = options?.runner ?? new NodeShellCommandRunner();
  const defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
  const maxTimeoutMs = options?.maxTimeoutMs ?? 600_000;

  return {
    name: "bash",
    aliases: ["Bash"],
    description: "Run a shell command in the PolitDeck workspace.",
    kind: "shell",
    inputSchema: {
      type: "object",
      required: ["command"],
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "integer" },
        description: { type: "string" },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: (input) => isReadOnlyShellCommand(input.command),
    isConcurrencySafe: (input) => isReadOnlyShellCommand(input.command),
    isOpenWorld: () => true,
    checkPermissions: async (input) => classifyBashPermission(input.command),
    execute: async (input, context) => {
      const timeoutMs = Math.min(Math.max(1, input.timeoutMs ?? defaultTimeoutMs), maxTimeoutMs);
      const result = await runner.run(input.command, {
        cwd: context.cwd,
        env: context.env,
        timeoutMs,
        signal: context.abortSignal,
      });

      if (result.timedOut) {
        throw new PolitDeckToolRuntimeError("tool_timeout", `Command timed out after ${timeoutMs}ms.`);
      }

      if (result.exitCode !== 0) {
        throw new PolitDeckToolRuntimeError("tool_execution_failed", "Shell command failed", {
          command: input.command,
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
          command: input.command,
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

export type { PolitDeckCommandOptions, PolitDeckCommandResult, PolitDeckCommandRunner } from "./bash/commandRunner.js";
