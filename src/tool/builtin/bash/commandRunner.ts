import { spawn } from "node:child_process";

export type PilotDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Called on each stdout chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStdout?: (chunk: string) => void;
  /** Called on each stderr chunk as it arrives. Errors thrown by the callback are swallowed. */
  onStderr?: (chunk: string) => void;
};

export type PilotDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type PilotDeckCommandRunner = {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult>;
};

export class NodeShellCommandRunner implements PilotDeckCommandRunner {
  run(command: string, options: PilotDeckCommandOptions): Promise<PilotDeckCommandResult> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn(command, {
        cwd: options.cwd,
        env: options.env,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        signal: options.signal,
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);

      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
        if (options.onStdout) {
          try {
            options.onStdout(chunk);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
        if (options.onStderr) {
          try {
            options.onStderr(chunk);
          } catch {
            // Progress callbacks are fire-and-forget; never crash the runner.
          }
        }
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        resolve({
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    });
  }
}
