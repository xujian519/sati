import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { GitWorktreeProvider } from "../../src/always-on/workspace/GitWorktreeProvider.js";
import { SnapshotCopyProvider } from "../../src/always-on/workspace/SnapshotCopyProvider.js";
import { WorkspaceProviderRegistry } from "../../src/always-on/workspace/WorkspaceProviderRegistry.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf-8" });
  return result.stdout.trim();
}

async function createRepository(): Promise<{
  root: string;
  repo: string;
  worktrees: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-always-on-"));
  const repo = join(root, "repo");
  const worktrees = join(root, "worktrees");
  await mkdir(repo, { recursive: true });
  await git(repo, "init");
  await git(repo, "config", "user.name", "Always-On Test");
  await git(repo, "config", "user.email", "always-on@example.test");
  await writeFile(join(repo, "modified.txt"), "initial\n", "utf-8");
  await writeFile(join(repo, "deleted.txt"), "delete me\n", "utf-8");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "initial");
  return { root, repo, worktrees };
}

test("clean repositories create a worktree without a checkpoint commit", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ baseDir: fixture.worktrees });
  const before = await git(fixture.repo, "rev-parse", "HEAD");

  const handle = await provider.prepare({
    projectRoot: fixture.repo,
    runId: "clean-run",
    planTitle: "Clean plan",
  });
  t.after(() => provider.dispose(handle, { keep: false }));

  assert.equal(await git(fixture.repo, "rev-parse", "HEAD"), before);
  assert.equal(handle.metadata.baseCommit, before);
});

test("dirty repositories checkpoint every change before creating the worktree", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const provider = new GitWorktreeProvider({ baseDir: fixture.worktrees });

  await writeFile(join(fixture.repo, "modified.txt"), "modified\n", "utf-8");
  await unlink(join(fixture.repo, "deleted.txt"));
  await writeFile(join(fixture.repo, "staged.txt"), "staged\n", "utf-8");
  await git(fixture.repo, "add", "staged.txt");
  await writeFile(join(fixture.repo, "untracked.txt"), "untracked\n", "utf-8");

  const handle = await provider.prepare({
    projectRoot: fixture.repo,
    runId: "dirty-run",
    planTitle: "  Execute\n the   migration  ",
  });
  t.after(() => provider.dispose(handle, { keep: false }));

  assert.equal(
    await git(fixture.repo, "log", "-1", "--pretty=%s"),
    "chore(always-on): checkpoint before executing Execute the migration",
  );
  assert.equal(await git(fixture.repo, "status", "--porcelain"), "");
  assert.equal(await readFile(join(handle.cwd, "modified.txt"), "utf-8"), "modified\n");
  assert.equal(await readFile(join(handle.cwd, "staged.txt"), "utf-8"), "staged\n");
  assert.equal(await readFile(join(handle.cwd, "untracked.txt"), "utf-8"), "untracked\n");
  await assert.rejects(readFile(join(handle.cwd, "deleted.txt"), "utf-8"));
  assert.equal(handle.metadata.baseCommit, await git(fixture.repo, "rev-parse", "HEAD"));
});

test("auto strategy keeps git-worktree applicable for dirty repositories", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.repo, "untracked.txt"), "dirty\n", "utf-8");

  const registry = new WorkspaceProviderRegistry();
  registry.add(new GitWorktreeProvider({ baseDir: fixture.worktrees }));
  registry.add(new SnapshotCopyProvider({
    baseDir: join(fixture.root, "snapshots"),
    maxBytes: 10_000_000,
  }));

  assert.equal((await registry.resolve(fixture.repo)).id, "git-worktree");
});

test("a failing commit hook aborts workspace preparation", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.repo, "modified.txt"), "dirty\n", "utf-8");
  const hook = join(fixture.repo, ".git", "hooks", "pre-commit");
  await writeFile(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const provider = new GitWorktreeProvider({ baseDir: fixture.worktrees });

  await assert.rejects(
    provider.prepare({
      projectRoot: fixture.repo,
      runId: "hook-failure",
      planTitle: "Blocked plan",
    }),
    /git commit failed/,
  );
});

test("a git add failure aborts workspace preparation", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.repo, "modified.txt"), "dirty\n", "utf-8");
  const gitWrapper = join(fixture.root, "git-wrapper");
  await writeFile(
    gitWrapper,
    "#!/bin/sh\nfor arg in \"$@\"; do\n  if [ \"$arg\" = \"add\" ]; then\n    exit 42\n  fi\ndone\nexec git \"$@\"\n",
    { mode: 0o755 },
  );
  const provider = new GitWorktreeProvider({
    baseDir: fixture.worktrees,
    gitBin: gitWrapper,
  });

  await assert.rejects(
    provider.prepare({
      projectRoot: fixture.repo,
      runId: "add-failure",
      planTitle: "Blocked plan",
    }),
    /git add -A failed/,
  );
});

test("a repository left dirty by a post-commit hook aborts workspace preparation", async (t) => {
  const fixture = await createRepository();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(join(fixture.repo, "modified.txt"), "dirty\n", "utf-8");
  const hook = join(fixture.repo, ".git", "hooks", "post-commit");
  await writeFile(hook, "#!/bin/sh\nprintf 'hook change\\n' > post-commit.txt\n", { mode: 0o755 });
  const provider = new GitWorktreeProvider({ baseDir: fixture.worktrees });

  await assert.rejects(
    provider.prepare({
      projectRoot: fixture.repo,
      runId: "post-hook-dirty",
      planTitle: "Post hook plan",
    }),
    /remained dirty/,
  );
});
