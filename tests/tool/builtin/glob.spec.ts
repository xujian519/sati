import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultPermissionContext } from "../../../src/permission/index.js";
import { createGlobTool, extractGlobBaseDirectory } from "../../../src/tool/index.js";
import { normalizeRipgrepGlobPattern } from "../../../src/tool/builtin/filesystem/ripgrepFiles.js";
import { PilotDeckToolRuntimeError } from "../../../src/tool/protocol/errors.js";
import type {
  PilotDeckToolExecutionOutput,
  PilotDeckToolRuntimeContext,
} from "../../../src/tool/protocol/types.js";

type GlobData = {
  files: string[];
  count: number;
  truncated: boolean;
};

test("extractGlobBaseDirectory splits absolute glob patterns for ripgrep", () => {
  assert.deepEqual(
    extractGlobBaseDirectory("/tmp_workspace/04_Search_Retrieval_task_2_conflicting_handling/laws/**/*"),
    {
      baseDir: "/tmp_workspace/04_Search_Retrieval_task_2_conflicting_handling/laws",
      relativePattern: "**/*",
    },
  );
  assert.deepEqual(extractGlobBaseDirectory("/workspace/src/tool/builtin/glob.ts"), {
    baseDir: "/workspace/src/tool/builtin",
    relativePattern: "glob.ts",
  });
});

test("normalizeRipgrepGlobPattern converts Windows path separators for ripgrep glob matching", () => {
  assert.equal(normalizeRipgrepGlobPattern("laws\\**\\*"), "laws/**/*");
  assert.equal(normalizeRipgrepGlobPattern("**\\*.ts"), "**/*.ts");
});

test("glob accepts absolute patterns that resolve inside the workspace", async () => {
  const root = await makeWorkspace();
  await mkdir(path.join(root, "laws", "nested"), { recursive: true });
  await writeFile(path.join(root, "laws", "law1.docx"), "law 1");
  await writeFile(path.join(root, "laws", "nested", "law2.pdf"), "law 2");

  const result = await runGlob(root, {
    pattern: path.join(root, "laws", "**", "*"),
  });

  assert.deepEqual(result.files, ["laws/law1.docx", "laws/nested/law2.pdf"]);
  assert.equal(result.count, 2);
  assert.equal(result.truncated, false);
});

test("glob accepts absolute literal file patterns inside the workspace", async () => {
  const root = await makeWorkspace();
  await mkdir(path.join(root, "src", "tool"), { recursive: true });
  await writeFile(path.join(root, "src", "tool", "glob.ts"), "export {};");

  const result = await runGlob(root, {
    pattern: path.join(root, "src", "tool", "glob.ts"),
  });

  assert.deepEqual(result.files, ["src/tool/glob.ts"]);
});

test("glob accepts Windows-style glob separators before calling ripgrep", async () => {
  const root = await makeWorkspace();
  await mkdir(path.join(root, "laws", "nested"), { recursive: true });
  await writeFile(path.join(root, "laws", "nested", "law2.pdf"), "law 2");

  const result = await runGlob(root, { pattern: "laws\\**\\*" });

  assert.deepEqual(result.files, ["laws/nested/law2.pdf"]);
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
});

test("glob does not require system ripgrep on PATH", async () => {
  const root = await makeWorkspace();
  await writeFile(path.join(root, "a.txt"), "a");

  const result = await runGlob(root, { pattern: "*.txt" }, { env: { PATH: "" } });

  assert.deepEqual(result.files, ["a.txt"]);
  assert.equal(result.count, 1);
  assert.equal(result.truncated, false);
});

test("glob rejects absolute patterns outside the workspace in default permission mode", async () => {
  const root = await makeWorkspace();
  const outside = await makeWorkspace();

  await assert.rejects(
    () => runGlob(root, { pattern: path.join(outside, "**", "*") }),
    (error) => error instanceof PilotDeckToolRuntimeError && error.code === "path_not_allowed",
  );
});

test("glob returns modified-time ordered results", async () => {
  const root = await makeWorkspace();
  await writeFile(path.join(root, "newer.txt"), "newer");
  await writeFile(path.join(root, "older.txt"), "older");
  await utimes(
    path.join(root, "older.txt"),
    new Date("2020-01-01T00:00:00.000Z"),
    new Date("2020-01-01T00:00:00.000Z"),
  );
  await utimes(
    path.join(root, "newer.txt"),
    new Date("2022-01-01T00:00:00.000Z"),
    new Date("2022-01-01T00:00:00.000Z"),
  );

  const result = await runGlob(root, { pattern: "*.txt" });

  assert.deepEqual(result.files, ["older.txt", "newer.txt"]);
});

async function makeWorkspace(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "pilotdeck-glob-test-"));
}

async function runGlob(
  cwd: string,
  input: { pattern: string; path?: string; limit?: number },
  options?: { env?: NodeJS.ProcessEnv },
): Promise<GlobData> {
  const tool = createGlobTool();
  const output = await tool.execute(
    input,
    createContext(cwd, options),
  ) as PilotDeckToolExecutionOutput<GlobData>;
  assert.ok(output.data);
  return output.data;
}

function createContext(
  cwd: string,
  options?: { env?: NodeJS.ProcessEnv },
): PilotDeckToolRuntimeContext {
  return {
    sessionId: "session-1",
    turnId: "turn-1",
    cwd,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({ cwd }),
    env: options?.env,
    now: () => new Date("2026-06-26T00:00:00.000Z"),
  };
}
