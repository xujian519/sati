import { spawn } from "node:child_process";

export type PolitDeckCommandOptions = {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type PolitDeckCommandResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
};

export type PolitDeckCommandRunner = {
  run(command: string, options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult>;
};

export class NodeShellCommandRunner implements PolitDeckCommandRunner {
  run(command: string, options: PolitDeckCommandOptions): Promise<PolitDeckCommandResult> {
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
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
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
