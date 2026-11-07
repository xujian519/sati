import assert from "node:assert/strict";
import test from "node:test";
import type { PilotConfigDiagnostic } from "../../../src/pilot/config/types.js";
import { parseRuntimeConfig } from "../../../src/pilot/config/parseRuntimeConfig.js";

function parse(raw: unknown): { runtime: ReturnType<typeof parseRuntimeConfig>; diagnostics: PilotConfigDiagnostic[] } {
  const diagnostics: PilotConfigDiagnostic[] = [];
  return { runtime: parseRuntimeConfig(raw, diagnostics), diagnostics };
}

test("段缺失返回 undefined", () => {
  const { runtime, diagnostics } = parse(undefined);
  assert.equal(runtime, undefined);
  assert.deepEqual(diagnostics, []);
});

test("解析 enabled 与 path", () => {
  const { runtime, diagnostics } = parse({ python: { enabled: false, path: "  /opt/python3  " } });
  assert.deepEqual(runtime, { python: { enabled: false, path: "/opt/python3" } });
  assert.deepEqual(diagnostics, []);
});

test("空 python 段返回 undefined", () => {
  const { runtime } = parse({ python: {} });
  assert.equal(runtime, undefined);
});

test("非法类型记 fatal 诊断", () => {
  const { runtime, diagnostics } = parse({ python: { enabled: "yes", path: "" } });

  assert.equal(runtime, undefined);
  assert.deepEqual(
    diagnostics.map(item => [item.code, item.severity, item.path]),
    [
      ["RUNTIME_PYTHON_ENABLED_INVALID", "fatal", "runtime.python.enabled"],
      ["RUNTIME_PYTHON_PATH_INVALID", "fatal", "runtime.python.path"],
    ],
  );
});

test("runtime 不是对象时记 fatal 诊断", () => {
  const { diagnostics } = parse("bad");
  assert.equal(diagnostics[0]?.code, "RUNTIME_CONFIG_INVALID");
  assert.equal(diagnostics[0]?.severity, "fatal");
});
