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
