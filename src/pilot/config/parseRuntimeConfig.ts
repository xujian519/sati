import { isRecord } from "../../model/config/schema.js";
import type { PythonRuntimeConfig } from "../../runtime/pythonRuntime.js";
import type { PilotConfigDiagnostic, PilotRuntimeConfig } from "./types.js";

/**
 * Parse the optional `runtime` section of `sati.yaml`.
 *
 *   runtime:
 *     python:
 *       enabled: true          # 缺省 true
 *       path: /usr/bin/python3 # 显式解释器；缺省按 VIRTUAL_ENV → PATH 解析
 *
 * 段缺失返回 undefined（行为与今天一致）。非法值记 fatal 诊断。
 */
export function parseRuntimeConfig(
  rawRuntime: unknown,
  diagnostics: PilotConfigDiagnostic[],
): PilotRuntimeConfig | undefined {
  if (rawRuntime === undefined) {
    return undefined;
  }
  if (!isRecord(rawRuntime)) {
    diagnostics.push({
      code: "RUNTIME_CONFIG_INVALID",
      severity: "fatal",
      message: "runtime config must be an object.",
      path: "runtime",
      recoverable: false,
    });
    return undefined;
  }

  const runtime: PilotRuntimeConfig = {};
  if (rawRuntime.python !== undefined) {
    const python = parsePythonConfig(rawRuntime.python, diagnostics);
    if (python) {
      runtime.python = python;
    }
  }
  return Object.keys(runtime).length > 0 ? runtime : undefined;
}

function parsePythonConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): PythonRuntimeConfig | undefined {
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "RUNTIME_PYTHON_INVALID",
      severity: "fatal",
      message: "runtime.python must be an object.",
      path: "runtime.python",
      recoverable: false,
    });
    return undefined;
  }

  const python: PythonRuntimeConfig = {};
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      diagnostics.push({
        code: "RUNTIME_PYTHON_ENABLED_INVALID",
        severity: "fatal",
        message: "runtime.python.enabled must be a boolean.",
        path: "runtime.python.enabled",
        recoverable: false,
      });
    } else {
      python.enabled = raw.enabled;
    }
  }

  if (raw.path !== undefined) {
    if (typeof raw.path !== "string" || raw.path.trim().length === 0) {
      diagnostics.push({
        code: "RUNTIME_PYTHON_PATH_INVALID",
        severity: "fatal",
        message: "runtime.python.path must be a non-empty string.",
        path: "runtime.python.path",
        recoverable: false,
      });
    } else {
      python.path = raw.path.trim();
    }
  }

  return Object.keys(python).length > 0 ? python : undefined;
}
