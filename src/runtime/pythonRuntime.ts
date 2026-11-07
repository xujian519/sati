import { spawnSync } from "node:child_process";
import { join } from "node:path";

/**
 * Python 运行时三态感知。
 *
 * 目的：让模型知道当前环境有没有 Python、用的是哪个解释器，避免臆造
 * 「已安装的库」或声称执行成功。这里只做**只读探测**：不安装、不修改
 * `process.env`、不打包解释器。
 */
export type PythonRuntimeConfig = {
  enabled?: boolean;
  /** 显式解释器路径；缺省按 VIRTUAL_ENV → PATH(python3/python) 解析。 */
  path?: string;
};

export type PythonRuntimeState = "disabled" | "ready" | "external" | "unavailable";

export type PythonRuntimeEnvironment = "configured" | "virtualenv" | "system" | "none";

export type PythonRuntimeStatus = {
  enabled: boolean;
  state: PythonRuntimeState;
  reason: string;
  environment: PythonRuntimeEnvironment;
  executable?: string;
  version?: string;
};

export type PythonProbeResult = {
  executable: string;
  version?: string;
};

export type PythonRuntimeOptions = {
  config?: PythonRuntimeConfig;
  env?: Record<string, string | undefined>;
  /** 测试注入：返回 undefined 表示该解释器不可用。 */
  probe?: (executable: string) => PythonProbeResult | undefined;
};

const PROBE_SCRIPT =
  "import json,sys;print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable}))";

const runtimeCache = new Map<string, PythonRuntimeStatus>();

/** 测试/配置重载用：清空探测缓存。 */
export function clearPythonRuntimeCache(): void {
  runtimeCache.clear();
}

export function resolvePythonRuntime(options: PythonRuntimeOptions = {}): PythonRuntimeStatus {
  if (options.probe) {
    return resolveUncached(options);
  }
  const env = options.env ?? process.env;
  const key = [
    options.config?.enabled === false ? "off" : "on",
    options.config?.path ?? "",
    env.VIRTUAL_ENV ?? "",
    env.PATH ?? "",
  ].join("|");
  const cached = runtimeCache.get(key);
  if (cached) {
    return cached;
  }
  const status = resolveUncached(options);
  runtimeCache.set(key, status);
  return status;
}

function resolveUncached(options: PythonRuntimeOptions): PythonRuntimeStatus {
  const config = options.config;
  if (config?.enabled === false) {
    return {
      enabled: false,
      state: "disabled",
      reason: "Python execution is disabled by runtime.python.enabled=false.",
      environment: "none",
    };
  }

  const probe = options.probe ?? probePython;
  const env = options.env ?? process.env;

  if (config?.path) {
    const probed = probe(config.path);
    return probed
      ? {
          enabled: true,
          state: "external",
          reason: "Using the interpreter configured in runtime.python.path.",
          environment: "configured",
          executable: probed.executable,
          ...(probed.version ? { version: probed.version } : {}),
        }
      : {
          enabled: true,
          state: "unavailable",
          reason: `runtime.python.path is not runnable: ${config.path}`,
          environment: "configured",
          executable: config.path,
        };
  }

  const virtualEnv = env.VIRTUAL_ENV;
  if (virtualEnv) {
    const candidate = join(virtualEnv, process.platform === "win32" ? "Scripts" : "bin", "python");
    const probed = probe(candidate);
    if (probed) {
      return {
        enabled: true,
        state: "external",
        reason: "Using the interpreter from the active VIRTUAL_ENV.",
        environment: "virtualenv",
        executable: probed.executable,
        ...(probed.version ? { version: probed.version } : {}),
      };
    }
  }

  for (const candidate of ["python3", "python"]) {
    const probed = probe(candidate);
    if (probed) {
      return {
        enabled: true,
        state: "ready",
        reason: "Using the first Python interpreter found on PATH.",
        environment: "system",
        executable: probed.executable,
        ...(probed.version ? { version: probed.version } : {}),
      };
    }
  }

  return {
    enabled: true,
    state: "unavailable",
    reason: "No runnable python3/python found on PATH.",
    environment: "none",
  };
}

/** 格式化为模型可见的 `<python-runtime>` 段（不含任何猜测的库清单）。 */
export function formatPythonRuntimeSection(status: PythonRuntimeStatus): string[] {
  const lines = ["<python-runtime>", `state: ${status.state}`, `environment: ${status.environment}`];
  if (status.executable) {
    lines.push(`executable: ${status.executable}`);
  }
  if (status.version) {
    lines.push(`version: ${status.version}`);
  }
  lines.push(`guidance: ${guidanceFor(status.state)}`);
  lines.push("</python-runtime>");
  return lines;
}

function guidanceFor(state: PythonRuntimeState): string {
  switch (state) {
    case "disabled":
      return "Python execution is disabled by configuration. Do not claim Python ran; use bash or node instead.";
    case "ready":
    case "external":
      return "Python is available. Verify imports before relying on third-party packages; do not assume a library is installed.";
    case "unavailable":
      return "Python is not available. Do not claim Python execution succeeded; use bash/node or state the limitation.";
  }
}

function probePython(executable: string): PythonProbeResult | undefined {
  const result = spawnSync(executable, ["-c", PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: 1_500,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return undefined;
  }
  const line = result.stdout.trim().split("\n").at(-1);
  if (!line) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as { version?: unknown; executable?: unknown };
    return {
      executable: typeof parsed.executable === "string" && parsed.executable ? parsed.executable : executable,
      ...(typeof parsed.version === "string" && parsed.version ? { version: parsed.version } : {}),
    };
  } catch {
    // 探测脚本输出被环境噪声污染时退化为「可执行但版本未知」。
    return { executable };
  }
}
