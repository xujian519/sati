/**
 * workspace_ship / registerLeak 测试。
 *
 * 覆盖：稠密轨符号泄漏、状态标记、未陈述覆盖范围的 verified 声明、
 * 复读循环、fenced code 不算散文、report-only 不拦截语义。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { scanRegisterLeak } from "../../../../src/context/workspace/registerLeak.js";
import { createWorkspaceShipTool } from "../../../../src/tool/builtin/workspace/WorkspaceShipTool.js";
import type { SatiToolRuntimeContext } from "../../../../src/tool/protocol/types.js";

test("clean text reports clean", () => {
  const result = scanRegisterLeak("The result was verified across all files and edge inputs.");
  assert.equal(result.clean, true);
});

test("dense-track symbols are detected in prose", () => {
  const result = scanRegisterLeak("We have A ⇒ B, and that implies C.");
  assert.equal(result.clean, false);
  assert.ok(result.findings.some(f => f.text.includes("dense-track")));
});

test("dense-track symbols inside fenced code are not prose", () => {
  const result = scanRegisterLeak("```js\nconst a = b ⇒ c;\n```\n");
  assert.equal(result.clean, true);
});

test("verified claim without coverage is flagged", () => {
  const result = scanRegisterLeak("The parser was verified.");
  assert.equal(result.clean, false);
  assert.ok(result.findings.some(f => f.line === 1));
});

test("verified claim with coverage is clean", () => {
  const result = scanRegisterLeak("The parser was verified across all ledger sections and edge inputs.");
  assert.equal(result.clean, true);
});

test("chinese verified claim without coverage is flagged", () => {
  const result = scanRegisterLeak("解析器已经验证。");
  assert.equal(result.clean, false);
});

test("repetition loop is detected", () => {
  const result = scanRegisterLeak("same\nsame\nsame\n");
  assert.equal(result.clean, false);
  assert.ok(result.findings.some(f => f.text.includes("repeats three")));
});

test("character run is detected", () => {
  const result = scanRegisterLeak("..........................\n");
  assert.equal(result.clean, false);
  assert.ok(result.findings.some(f => f.text.includes("character run")));
});

test("ship tool is report-only and completes regardless", async () => {
  const tool = createWorkspaceShipTool();
  const context: SatiToolRuntimeContext = {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: {} as never,
  };
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(join(tmpdir(), "ship-"));
  const cleanPath = join(dir, "clean.md");
  await writeFile(cleanPath, "All files verified across edge inputs.\n", "utf8");
  const cleanOut = await tool.execute({ file: cleanPath }, context);
  assert.equal(cleanOut.data!.clean, true);

  const dirtyPath = join(dir, "dirty.md");
  await writeFile(dirtyPath, "The result was verified. ⇒ leak.\n", "utf8");
  const dirtyOut = await tool.execute({ file: dirtyPath }, context);
  assert.equal(dirtyOut.data!.clean, false);
  assert.ok(dirtyOut.data!.findings.length > 0);
});

test("ship tool reports unreadable file", async () => {
  const tool = createWorkspaceShipTool();
  const context: SatiToolRuntimeContext = {
    sessionId: "s1",
    turnId: "t1",
    cwd: "/tmp",
    permissionMode: "default",
    permissionContext: {} as never,
  };
  await assert.rejects(() => tool.execute({ file: "no-such-file.md" }, context));
});
