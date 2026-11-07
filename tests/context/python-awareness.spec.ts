import assert from "node:assert/strict";
import test from "node:test";
import { NullExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";
import type { PythonRuntimeStatus } from "../../src/runtime/pythonRuntime.js";

const READY: PythonRuntimeStatus = {
  enabled: true,
  state: "ready",
  reason: "found",
  environment: "system",
  executable: "/usr/bin/python3",
  version: "3.12.1",
};

function assemble(pythonRuntime?: PythonRuntimeStatus): string {
  return new PromptAssembler(new NullExtensionResolver()).assemble({
    cwd: "/tmp/project",
    provider: "test",
    model: "test-model",
    permissionMode: "default",
    additionalWorkingDirectories: [],
    tools: [],
    ...(pythonRuntime ? { pythonRuntime } : {}),
  }).joined;
}

test("注入 <python-runtime> 并带版本与解释器", () => {
  const prompt = assemble(READY);

  assert.match(prompt, /<python-runtime>/);
  assert.match(prompt, /state: ready/);
  assert.match(prompt, /executable: \/usr\/bin\/python3/);
  assert.match(prompt, /version: 3\.12\.1/);
  assert.match(prompt, /Verify imports/);
});

test("unavailable 状态给出不臆造执行的指引", () => {
  const prompt = assemble({
    enabled: true,
    state: "unavailable",
    reason: "missing",
    environment: "none",
  });

  assert.match(prompt, /state: unavailable/);
  assert.match(prompt, /Do not claim Python execution succeeded/);
});

test("未提供状态时不注入块", () => {
  assert.doesNotMatch(assemble(), /<python-runtime>/);
});
