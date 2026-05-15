/**
 * Workspace apply & dispose helpers.
 *
 * These are standalone functions (not tied to a provider instance) so
 * that `DiscoveryPlanService` can call them through dependency injection
 * without needing the full provider registry at construction time.
 */

import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { AlwaysOnError } from "../protocol/errors.js";

type GitResult = { exitCode: number; stdout: string; stderr: string };

async function runGit(bin: string, args: string[]): Promise<GitResult> {
  return new Promise<GitResult>((resolve) => {
    const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdin?.end();
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
  });
}

/**
 * Apply uncommitted changes from a git worktree back to the original
 * project root using `git diff` + `git apply --3way`.
 */
export async function applyWorktreeToProject(
  worktreeCwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<{ applied: boolean; diff?: string; error?: string }> {
  // Stage everything in the worktree so `diff HEAD` captures new files too.
  const addAll = await runGit(gitBin, ["-C", worktreeCwd, "add", "-A"]);
  if (addAll.exitCode !== 0) {
    return { applied: false, error: `git add -A failed: ${addAll.stderr}` };
  }

  const diffResult = await runGit(gitBin, [
    "-C", worktreeCwd,
    "diff", "--cached", "HEAD",
    "--binary",
  ]);
  if (diffResult.exitCode !== 0) {
    return { applied: false, error: `git diff failed: ${diffResult.stderr}` };
  }

  const patch = diffResult.stdout;
  if (!patch.trim()) {
    return { applied: true, diff: "" };
  }

  // Pipe the diff into `git apply --3way` in the original project root.
  const applyResult = await new Promise<GitResult>((resolve) => {
    const child = spawn(gitBin, ["-C", projectRoot, "apply", "--3way"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      resolve({ exitCode: -1, stdout, stderr: error.message });
    });
    child.on("close", (code) => {
      resolve({ exitCode: code ?? -1, stdout, stderr });
    });
    child.stdin?.write(patch);
    child.stdin?.end();
  });

  if (applyResult.exitCode !== 0) {
    return {
      applied: false,
      diff: patch,
      error: `git apply failed: ${applyResult.stderr || applyResult.stdout}`,
    };
  }

  return { applied: true, diff: patch };
}

/**
 * Remove an isolated workspace from disk.
 *
 * For git-worktree: `git worktree remove --force`, fallback to rm + prune.
 * For snapshot-copy: plain `rm -rf`.
 */
export async function disposeWorkspace(
  strategy: string,
  cwd: string,
  projectRoot: string,
  gitBin = "git",
): Promise<void> {
  if (strategy === "git-worktree") {
    const remove = await runGit(gitBin, [
      "-C", projectRoot,
      "worktree", "remove", "--force", cwd,
    ]).catch(() => undefined);

    if (!remove || remove.exitCode !== 0) {
      await rm(cwd, { recursive: true, force: true });
      await runGit(gitBin, ["-C", projectRoot, "worktree", "prune"]).catch(
        () => undefined,
      );
    }
    return;
  }

  // snapshot-copy or unknown: just rm.
  await rm(cwd, { recursive: true, force: true });
}
