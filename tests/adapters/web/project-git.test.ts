import test from "node:test";
import assert from "node:assert/strict";
import {
  ProjectGitService,
  parsePorcelainV2,
} from "../../../src/adapters/web/projectGit.js";

test("parsePorcelainV2 extracts branch and modified files", () => {
  const sample = [
    "# branch.head main",
    "# branch.ab +0 -0",
    "1 .M N... 100644 100644 100644 abc abc src/index.ts",
    "? new-file.txt",
  ].join("\n");
  const result = parsePorcelainV2(sample);
  assert.equal(result.branch, "main");
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
  assert.equal(result.files.length, 2);
  const modified = result.files.find((f) => f.path === "src/index.ts");
  assert.ok(modified);
  assert.equal(modified?.unstaged, true);
  const untracked = result.files.find((f) => f.path === "new-file.txt");
  assert.ok(untracked);
  assert.equal(untracked?.untracked, true);
});

test("ProjectGitService.status delegates to runner", async () => {
  const service = new ProjectGitService({
    projectRoot: "/tmp/x",
    runner: async () => ({
      stdout: "# branch.head main\n? a.txt\n",
      stderr: "",
      code: 0,
    }),
  });
  const status = await service.status();
  assert.equal(status.branch, "main");
  assert.equal(status.files.length, 1);
});

test("ProjectGitService.diff includes path argument when provided", async () => {
  let capturedArgs: string[] = [];
  const service = new ProjectGitService({
    projectRoot: "/tmp/x",
    runner: async (args) => {
      capturedArgs = args;
      return { stdout: "diff --git a/x b/x\n", stderr: "", code: 0 };
    },
  });
  const diff = await service.diff("path/to/file.ts");
  assert.deepEqual(capturedArgs, ["diff", "--unified=3", "--", "path/to/file.ts"]);
  assert.equal(diff.path, "path/to/file.ts");
  assert.match(diff.diff, /^diff --git/);
});
