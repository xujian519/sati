import assert from "node:assert/strict";
import test from "node:test";
import {
  formatPythonRuntimeSection,
  resolvePythonRuntime,
  type PythonProbeResult,
} from "../../src/runtime/pythonRuntime.js";

test("runtime.python.enabled=false → disabled，且不探测", () => {
  let probed = false;
  const status = resolvePythonRuntime({
    config: { enabled: false },
    probe: () => {
      probed = true;
      return undefined;
    },
  });

  assert.equal(status.state, "disabled");
  assert.equal(status.enabled, false);
  assert.equal(status.environment, "none");
  assert.equal(probed, false);
});

test("显式 path 命中 → external / configured", () => {
  const status = resolvePythonRuntime({
    config: { path: "/opt/python3" },
    probe: executable => ({ executable, version: "3.12.1" }),
  });

  assert.equal(status.state, "external");
  assert.equal(status.environment, "configured");
  assert.equal(status.executable, "/opt/python3");
  assert.equal(status.version, "3.12.1");
});

test("显式 path 不可运行 → unavailable（不回退到 PATH）", () => {
  const status = resolvePythonRuntime({
    config: { path: "/missing/python" },
    probe: () => undefined,
  });

  assert.equal(status.state, "unavailable");
  assert.equal(status.environment, "configured");
  assert.equal(status.executable, "/missing/python");
  assert.match(status.reason, /not runnable/);
});

test("VIRTUAL_ENV 优先于 PATH", () => {
  const calls: string[] = [];
  const status = resolvePythonRuntime({
    env: { VIRTUAL_ENV: "/venv", PATH: "/usr/bin" },
    probe: (executable): PythonProbeResult | undefined => {
      calls.push(executable);
      return executable === "/venv/bin/python" ? { executable, version: "3.11.4" } : undefined;
    },
  });

  assert.equal(status.state, "external");
  assert.equal(status.environment, "virtualenv");
  assert.equal(status.executable, "/venv/bin/python");
  assert.deepEqual(calls, ["/venv/bin/python"]);
});

test("PATH 上优先 python3，其次 python", () => {
  const first = resolvePythonRuntime({
    env: { PATH: "/usr/bin" },
    probe: executable => (executable === "python3" ? { executable: "/usr/bin/python3", version: "3.12.0" } : undefined),
  });
  assert.equal(first.state, "ready");
  assert.equal(first.environment, "system");
  assert.equal(first.executable, "/usr/bin/python3");

  const second = resolvePythonRuntime({
    env: { PATH: "/usr/bin" },
    probe: executable => (executable === "python" ? { executable: "/usr/bin/python", version: "3.10.0" } : undefined),
  });
  assert.equal(second.state, "ready");
  assert.equal(second.executable, "/usr/bin/python");
});

test("都不可用 → unavailable", () => {
  const status = resolvePythonRuntime({ env: { PATH: "/empty" }, probe: () => undefined });

  assert.equal(status.state, "unavailable");
  assert.equal(status.environment, "none");
  assert.equal(status.executable, undefined);
  assert.match(status.reason, /No runnable/);
});

test("prompt 段包含状态与保守指引，不臆造库清单", () => {
  const lines = formatPythonRuntimeSection({
    enabled: true,
    state: "unavailable",
    reason: "missing",
    environment: "none",
  });
  const text = lines.join("\n");

  assert.match(text, /<python-runtime>/);
  assert.match(text, /state: unavailable/);
  assert.match(text, /Do not claim Python execution succeeded/);
  assert.doesNotMatch(text, /numpy|pandas/);
});
