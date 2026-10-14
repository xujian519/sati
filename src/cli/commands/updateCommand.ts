/**
 * `sati update` — 从 git 远端更新（P2.7 从 `cli/sati.ts` 搬出）。
 *
 * `--check` 只比较本地/远端 HEAD 打印差异；默认（或 `--restart`）直接执行仓库根的
 * `scripts/update.sh`（stdio 继承，颜色强制开启）。`exit 2` 视为「已是最新」而非失败。
 *
 * **非逐 token 搬迁的改写**：原函数位于 `src/cli/sati.ts`，`__filename` 的目录是
 * `dist/src/cli`，向上三级即仓库根；本模块在 `dist/src/cli/commands`，必须向上四级。
 * 该路径推导抽成 `resolveUpdatePaths` 以便直测（见 tests/cli/update-command-paths.spec.ts）。
 */

import { execFileSync } from "node:child_process";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { plainLogger as out } from "../../telemetry/index.js";

export function resolveUpdatePaths(moduleUrl: string): { projectRoot: string; scriptPath: string } {
  const moduleDir = dirname(fileURLToPath(moduleUrl));
  const projectRoot = resolvePath(moduleDir, "..", "..", "..", "..");
  return { projectRoot, scriptPath: resolvePath(projectRoot, "scripts", "update.sh") };
}

export async function runUpdateCommand(argv: string[]): Promise<void> {
  const { projectRoot, scriptPath } = resolveUpdatePaths(import.meta.url);

  const doRestart = argv.includes("--restart");
  const checkOnly = argv.includes("--check");

  if (checkOnly) {
    try {
      const branch =
        execFileSync("git", ["branch", "--show-current"], { cwd: projectRoot, encoding: "utf-8" }).trim() || "main";
      execFileSync("git", ["fetch", "origin", branch], { cwd: projectRoot, encoding: "utf-8", stdio: "pipe" });
      const local = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf-8" }).trim();
      const remote = execFileSync("git", ["rev-parse", `origin/${branch}`], {
        cwd: projectRoot,
        encoding: "utf-8",
      }).trim();

      if (local === remote) {
        out.info(`Already up-to-date (${local.slice(0, 8)}) on branch ${branch}`);
      } else {
        const countStr = execFileSync("git", ["rev-list", "--count", `HEAD..origin/${branch}`], {
          cwd: projectRoot,
          encoding: "utf-8",
        }).trim();
        out.info(`Update available: ${countStr} new commit(s) on branch ${branch}`);
        out.info(`  local:  ${local.slice(0, 8)}`);
        out.info(`  remote: ${remote.slice(0, 8)}`);
        const log = execFileSync("git", ["log", "--oneline", `HEAD..origin/${branch}`, "-5"], {
          cwd: projectRoot,
          encoding: "utf-8",
        }).trim();
        if (log) {
          out.info("\nRecent commits:");
          out.info(log);
        }
      }
    } catch (e: unknown) {
      out.error(`Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    }
    return;
  }

  const args = doRestart ? [scriptPath, "--restart"] : [scriptPath];

  try {
    execFileSync("bash", args, {
      cwd: projectRoot,
      stdio: "inherit",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
  } catch (e: unknown) {
    const err = e as { status?: number };
    if (err.status === 2) {
      // Already up-to-date — not an error
      return;
    }
    out.error(`Update failed with exit code ${err.status ?? "unknown"}`);
    process.exitCode = 1;
  }
}
