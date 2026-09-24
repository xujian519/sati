/**
 * `GET /api/git/status` 的分桶判据（issue #415）。
 *
 * 判据钉的是「**没有一个已变更条目会被静默丢弃**」这条不变式：
 * `parseStatusBuckets()` 四个桶的条目数之和必须恰好等于 `git status --porcelain`
 * 的条目数。此前 `R`/`C` 落不进任何分支，重命名过的文件在 Git 面板里整条消失。
 *
 * 样本分两层：真实 `git mv` / `git status --porcelain` 产出的行（防止手写样本
 * 与真实格式漂移），以及覆盖其余状态码的字面样本。
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { parseCommitLogWithStats } from "../utils/gitCommitLog.js";

const nativeFetch = globalThis.fetch;
const tempDirs = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseStatusBuckets", () => {
  it("buckets a real `git mv` as a modification of the new path", async () => {
    const { runGit } = createRepository();
    runGit(["mv", "a.txt", "b.txt"]);
    const porcelain = runGit(["status", "--porcelain"]);

    expect(porcelain.trim()).toBe("R  a.txt -> b.txt");

    const buckets = await parseStatusBucketsOf(porcelain);

    expect(buckets.modified).toEqual(["b.txt"]);
    expect(buckets.added).toEqual([]);
    expect(buckets.deleted).toEqual([]);
    expect(buckets.untracked).toEqual([]);
  });

  it("keeps a rename visible next to an unrelated untracked file", async () => {
    const { dir, runGit } = createRepository();
    runGit(["mv", "a.txt", "renamed.txt"]);
    writeFileSync(join(dir, "notes.md"), "draft\n");

    const buckets = await parseStatusBucketsOf(runGit(["status", "--porcelain"]));

    expect(buckets.modified).toEqual(["renamed.txt"]);
    expect(buckets.untracked).toEqual(["notes.md"]);
  });

  it("places every porcelain entry in exactly one bucket", async () => {
    const lines = [
      " M src/modified-in-worktree.ts",
      "M  src/staged.ts",
      "MM src/staged-and-modified.ts",
      "A  src/added.ts",
      "AM src/added-then-modified.ts",
      "D  src/deleted.ts",
      " D src/deleted-in-worktree.ts",
      "R  old/name.ts -> new/name.ts",
      "C  src/copied.ts -> src/copy.ts",
      "T  src/typechange.ts",
      "UU src/conflicted.ts",
      "?? src/untracked.ts",
      "?? src/untracked-dir/",
    ];

    const buckets = await parseStatusBucketsOf(`${lines.join("\n")}\n`);

    expect(buckets.modified).toEqual([
      "src/modified-in-worktree.ts",
      "src/staged.ts",
      "src/staged-and-modified.ts",
      "new/name.ts",
      "src/copy.ts",
      "src/typechange.ts",
      "src/conflicted.ts",
    ]);
    expect(buckets.added).toEqual(["src/added.ts", "src/added-then-modified.ts"]);
    expect(buckets.deleted).toEqual(["src/deleted.ts", "src/deleted-in-worktree.ts"]);
    expect(buckets.untracked).toEqual(["src/untracked.ts", "src/untracked-dir/"]);

    // 不变式：条目总数守恒——「静默丢弃」类缺陷唯一有效的判据形态
    const total = Object.values(buckets).reduce((sum, paths) => sum + paths.length, 0);
    expect(total).toBe(lines.length);
  });

  it("survives empty and CRLF-ish output", async () => {
    const empty = { modified: [], added: [], deleted: [], untracked: [] };
    expect(await parseStatusBucketsOf("")).toEqual(empty);
    expect(await parseStatusBucketsOf("\n  \n")).toEqual(empty);
    expect((await parseStatusBucketsOf("?? src/a.ts\r\n")).untracked).toEqual(["src/a.ts"]);
  });
});

describe("GET /api/git/status", () => {
  it("reports renamed files in the change list", async () => {
    const { dir, runGit } = createRepository();
    runGit(["mv", "a.txt", "b.txt"]);

    const { request } = await createGitApp(dir);
    const { status, body } = await request("/api/git/status?project=demo");

    expect(status).toBe(200);
    expect(body.modified).toEqual(["b.txt"]);
    expect(body.added).toEqual([]);
    expect(body.deleted).toEqual([]);
    expect(body.untracked).toEqual([]);
  });
});

async function parseStatusBucketsOf(porcelain) {
  const { parseStatusBuckets } = await loadGitModule();
  return parseStatusBuckets(porcelain);
}

/**
 * Load `git.js` with its two heavy neighbours mocked out.
 *
 * `git.js` itself only needs `extractProjectDirectory` (project lookup) and
 * `runChatViaGateway` (one unrelated endpoint); importing them for real drags
 * in the whole `src/` chain — which a pure `--porcelain` parser test has no
 * business booting. The reset keeps each load's own mock authoritative instead
 * of reusing the module instance an earlier test imported.
 */
async function loadGitModule(projectDir = "/tmp/unused-project") {
  vi.resetModules();
  vi.doMock("../projects.js", () => ({
    extractProjectDirectory: vi.fn(async () => projectDir),
  }));
  vi.doMock("../sati-bridge.js", () => ({
    runChatViaGateway: vi.fn(async () => undefined),
  }));
  return import("./git.js");
}

/** Create a real throwaway git repo with one commit and one tracked file. */
function createRepository() {
  const dir = mkdtempSync(join(tmpdir(), "sati-git-status-"));
  tempDirs.push(dir);
  const runGit = args =>
    execFileSync("git", args, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "tester",
        GIT_AUTHOR_EMAIL: "tester@example.com",
        GIT_COMMITTER_NAME: "tester",
        GIT_COMMITTER_EMAIL: "tester@example.com",
      },
    });

  runGit(["init", "-q"]);
  writeFileSync(join(dir, "a.txt"), "hello\n");
  runGit(["add", "a.txt"]);
  runGit(["commit", "-q", "-m", "init"]);
  return { dir, runGit };
}

async function createGitApp(projectDir) {
  const { default: gitRoutes } = await loadGitModule(projectDir);
  const app = express();
  app.use(express.json());
  app.use("/api/git", gitRoutes);
  return {
    request: async (path, init) => {
      const server = app.listen(0);
      try {
        const { port } = server.address();
        const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, init);
        return { status: response.status, body: await response.json() };
      } finally {
        await new Promise(resolve => server.close(resolve));
      }
    },
  };
}

// ---------------------------------------------------------------------------
// #534 — /commits collapses the per-commit `git show --stat` fan-out into one
// `git log --stat` call, parsed by parseCommitLogWithStats.
// ---------------------------------------------------------------------------

/** Commit a new file so the repo has real, non-empty `--stat` output. */
function commitFile(dir, runGit, name, content, message) {
  writeFileSync(join(dir, name), content);
  runGit(["add", name]);
  runGit(["commit", "-q", "-m", message]);
}

/**
 * The summary line the *old* implementation produced, for equivalence checks.
 * The old path did `git show --stat --format=` → `.trim().split("\n").pop()`,
 * which left a leading space on the popped line (`.trim()` only strips the outer
 * edges of the whole blob). `parseCommitLogWithStats` trims each line, so we
 * normalize here — the only difference is that cosmetic leading space.
 */
function legacyStatSummary(runGit, hash) {
  return runGit(["show", "--stat", "--format=", hash]).trim().split("\n").pop().trim();
}

describe("parseCommitLogWithStats", () => {
  it("splits by the 40-hex header, not by blank lines", () => {
    const h1 = "a".repeat(40);
    const h2 = "b".repeat(40);
    const stdout = [
      `${h1}|ann|ann@x.com|2026-09-24T10:00:00+08:00|first`,
      "",
      " a.txt | 2 +-",
      " 1 file changed, 1 insertion(+), 1 deletion(-)",
      "",
      `${h2}|bob|bob@x.com|2026-09-24T11:00:00+08:00|second`,
      "",
      " b.txt | 3 +++",
      " 1 file changed, 3 insertions(+)",
      "",
    ].join("\n");

    const commits = parseCommitLogWithStats(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({ hash: h1, author: "ann", message: "first" });
    expect(commits[0].stats).toBe("1 file changed, 1 insertion(+), 1 deletion(-)");
    expect(commits[1].stats).toBe("1 file changed, 3 insertions(+)");
  });

  it("keeps a `|` inside the subject intact", () => {
    const h = "c".repeat(40);
    const commits = parseCommitLogWithStats(`${h}|ann|ann@x.com|2026-09-24T10:00:00+08:00|fix: a | b | c`);
    expect(commits[0].message).toBe("fix: a | b | c");
  });

  it("returns stats === '' for a merge commit (no --stat block, no trailing blank)", () => {
    const hm = "d".repeat(40);
    const h1 = "e".repeat(40);
    // A merge header immediately followed by the next commit's header: the
    // merge has no stat block AND no separating blank line — the exact shape
    // that broke blank-line chunking.
    const stdout = [
      `${hm}|ann|ann@x.com|2026-09-24T12:00:00+08:00|Merge branch 'feature'`,
      `${h1}|ann|ann@x.com|2026-09-24T10:00:00+08:00|first`,
      "",
      " a.txt | 2 +-",
      " 1 file changed, 1 insertion(+), 1 deletion(-)",
    ].join("\n");

    const commits = parseCommitLogWithStats(stdout);
    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe("Merge branch 'feature'");
    expect(commits[0].stats).toBe("");
    expect(commits[1].stats).toBe("1 file changed, 1 insertion(+), 1 deletion(-)");
  });

  it("parses rename and binary summary lines", () => {
    const h = "f".repeat(40);
    const stdout = [
      `${h}|ann|ann@x.com|2026-09-24T10:00:00+08:00|rename`,
      "",
      " old.txt => new.txt | 0",
      " bin.dat | Bin 0 -> 1024 bytes",
      " 2 files changed, 0 insertions(+), 0 deletions(-)",
    ].join("\n");
    expect(parseCommitLogWithStats(stdout)[0].stats).toBe("2 files changed, 0 insertions(+), 0 deletions(-)");
  });

  it("returns [] for empty output", () => {
    expect(parseCommitLogWithStats("")).toEqual([]);
  });
});

describe("GET /api/git/commits", () => {
  it("matches the legacy per-commit `git show --stat` summary line for each commit", async () => {
    const { dir, runGit } = createRepository(); // 1 commit: init
    commitFile(dir, runGit, "b.txt", "second\n", "second commit");
    commitFile(dir, runGit, "c.txt", "third\n", "third commit");

    const { request } = await createGitApp(dir);
    const { status, body } = await request("/api/git/commits?project=demo");

    expect(status).toBe(200);
    expect(body.commits).toHaveLength(3);
    // Newest-first; every stats string must equal what the old N-spawn path gave.
    for (const commit of body.commits) {
      expect(commit.stats).toBe(legacyStatSummary(runGit, commit.hash));
      expect(commit.stats).toMatch(/files? changed/);
    }
    expect(body.commits.map(c => c.message)).toEqual(["third commit", "second commit", "init"]);
  });

  it("returns stats === '' for a real merge commit", async () => {
    const { dir, runGit } = createRepository();
    const baseBranch = runGit(["branch", "--show-current"]).trim();
    commitFile(dir, runGit, "main.txt", "on base\n", "base work");
    runGit(["checkout", "-q", "-b", "feature"]);
    commitFile(dir, runGit, "feature.txt", "on feature\n", "feature work");
    runGit(["checkout", "-q", baseBranch]);
    runGit(["merge", "--no-ff", "-m", "Merge feature into base", "feature"]);

    const { request } = await createGitApp(dir);
    const { body } = await request("/api/git/commits?project=demo");

    const merge = body.commits.find(c => c.message.startsWith("Merge feature"));
    expect(merge, "merge commit present").toBeDefined();
    expect(merge.stats).toBe("");
    // Non-merge commits still carry a real summary.
    const base = body.commits.find(c => c.message === "base work");
    expect(base.stats).toMatch(/files? changed/);
  });

  it("honours limit and falls back to 10 for invalid values", async () => {
    const { dir, runGit } = createRepository();
    commitFile(dir, runGit, "b.txt", "b\n", "second");
    commitFile(dir, runGit, "c.txt", "c\n", "third");

    const { request } = await createGitApp(dir);
    expect((await request("/api/git/commits?project=demo&limit=2")).body.commits).toHaveLength(2);
    // limit=0 and limit=abc are invalid → default 10 (repo has 3) → all 3.
    expect((await request("/api/git/commits?project=demo&limit=0")).body.commits).toHaveLength(3);
    expect((await request("/api/git/commits?project=demo&limit=abc")).body.commits).toHaveLength(3);
    // A huge limit is clamped to 100; the repo only has 3 so all 3 come back.
    expect((await request("/api/git/commits?project=demo&limit=999")).body.commits).toHaveLength(3);
  });
});
