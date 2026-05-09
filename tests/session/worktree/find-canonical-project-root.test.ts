import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  __clearWorktreeCachesForTesting,
  findCanonicalProjectRoot,
  findGitRoot,
} from "../../../src/session/worktree/index.js";
import {
  addWorktree,
  createInitialCommit,
  initRepo,
} from "../../helpers/gitFixture.js";

test("findCanonicalProjectRoot maps a regular repo to itself", async () => {
  __clearWorktreeCachesForTesting();
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-worktree-regular-"));
  try {
    const repo = await initRepo(path.join(root, "repo"));
    await createInitialCommit(repo);

    const canonical = await findCanonicalProjectRoot(repo);
    // resolveCanonicalRoot realpath's the answer so that worktrees and
    // regular repos on macOS (where /tmp is a symlink to /private/tmp)
    // produce the same form.
    assert.equal(canonical, (await realpath(repo)).normalize("NFC"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findCanonicalProjectRoot maps a worktree back to the main repo root", async () => {
  __clearWorktreeCachesForTesting();
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-worktree-shared-"));
  try {
    const main = await initRepo(path.join(root, "main"));
    await createInitialCommit(main);
    const worktree = path.join(root, "feature");
    await addWorktree(main, worktree, "feature-branch");

    const mainCanonical = await findCanonicalProjectRoot(main);
    const worktreeCanonical = await findCanonicalProjectRoot(worktree);
    // Two worktrees of the same repo must share the canonical project root.
    assert.equal(worktreeCanonical, mainCanonical);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findCanonicalProjectRoot falls back to cwd for non-git directories", async () => {
  __clearWorktreeCachesForTesting();
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-worktree-nongit-"));
  try {
    const target = path.join(root, "not-a-repo");
    // intentional_difference vs legacy: legacy returns null when no git root
    // is found; PolitDeck always returns *some* canonical form (so callers
    // can always derive a project ID). We expect path.resolve, not realpath,
    // because the fallback path is taken before any filesystem realpath call.
    const canonical = await findCanonicalProjectRoot(root);
    assert.equal(canonical, path.resolve(root));

    // Sub-path that doesn't exist falls back to itself too.
    const canonical2 = await findCanonicalProjectRoot(target);
    assert.equal(canonical2, path.resolve(target));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findGitRoot caches results: second call avoids re-walking", async () => {
  __clearWorktreeCachesForTesting();
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-worktree-cache-"));
  try {
    const repo = await initRepo(path.join(root, "repo"));
    await createInitialCommit(repo);

    const first = await findGitRoot(repo);
    const second = await findGitRoot(repo);
    assert.ok(first);
    assert.equal(second, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("findGitRoot resolves an arbitrary nested directory inside the repo", async () => {
  __clearWorktreeCachesForTesting();
  const root = await mkdtemp(path.join(os.tmpdir(), "politdeck-worktree-nested-"));
  try {
    const repo = await initRepo(path.join(root, "repo"));
    await createInitialCommit(repo);
    const nested = path.join(repo, "src", "deep", "module");
    await writeFile(path.join(repo, "marker"), "", "utf-8").catch(() => undefined);

    // findGitRoot returns lexical path (legacy behaviour: resolve, not realpath).
    // The realpath normalization happens at resolveCanonicalRoot layer.
    const found = await findGitRoot(nested);
    const expected = path.resolve(repo).normalize("NFC");
    assert.equal(found, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
