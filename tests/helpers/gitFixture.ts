import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Run `git init` in `dir` with a configured user.name/email so subsequent
 * commits do not depend on the host git config. Returns the absolute,
 * resolved path of the repo root.
 */
export async function initRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await exec("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await exec("git", ["config", "user.email", "test@pilotdeck.local"], { cwd: dir });
  await exec("git", ["config", "user.name", "PilotDeck Test"], { cwd: dir });
  await exec("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

/**
 * Create a tracked file and make a single commit so HEAD exists and
 * `git worktree add` is happy.
 */
export async function createInitialCommit(dir: string): Promise<void> {
  const file = path.join(dir, "README.md");
  await writeFile(file, "# fixture\n", "utf-8");
  await exec("git", ["add", "README.md"], { cwd: dir });
  await exec("git", ["commit", "-q", "-m", "initial"], { cwd: dir });
}

/**
 * Add a linked git worktree at `worktreePath` checked out to `branch`. The
 * branch is created from HEAD of the main repo.
 */
export async function addWorktree(
  mainRepo: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await exec(
    "git",
    ["worktree", "add", "-b", branch, worktreePath, "HEAD"],
    { cwd: mainRepo },
  );
}
