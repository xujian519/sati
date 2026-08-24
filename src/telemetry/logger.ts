import { debugLog } from "../shared/debug.js";

/**
 * 本地结构化日志 helper（TD-CONSOLE-001 收束目标）。
 *
 * 把散落在 `src/` 各模块的裸 `console.*` 收束到统一入口：
 * - `info`  → `console.log`（stdout，与现状一致）
 * - `warn`  → `console.warn`（stderr）
 * - `error` → `console.error`（stderr）
 * - `debug` → `debugLog`（受 `SATI_DEBUG=1|true` 门控，见 `src/shared/debug.ts`）
 *
 * 刻意不引入第三方日志库（仓库无 pino/winston/chalk 约定）、不做落盘
 * （桌面端 `desktop.server.log` 已镜像 stdout/stderr，analytics queue 已由
 * `TelemetrySender` 持久化）。namespace 即方括号内容：`"sati"` → `[sati] `；
 * `""` → 无前缀（供消息已自带完整前缀的下游使用，防双重前缀）。
 */

export type LoggerLevel = "info" | "warn" | "error" | "debug";

export type Logger = {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
};

export type CreateLoggerOptions = {
  /** 注入级别标签（如 `[sati] warn ...`）。默认 false，保持 `[sati] msg` 现状。 */
  levelTag?: boolean;
  /** ISO 时间戳前缀。默认 false。 */
  timestamp?: boolean;
};

const LEVEL_TAGS: Record<LoggerLevel, string> = {
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

export function createLogger(namespace: string, options: CreateLoggerOptions = {}): Logger {
  const prefix = namespace ? `[${namespace}] ` : "";
  const { levelTag = false, timestamp = false } = options;

  const format = (level: LoggerLevel, message: string): string => {
    let out = prefix + message;
    if (levelTag) {
      out = `[${LEVEL_TAGS[level]}] ${out}`;
    }
    if (timestamp) {
      out = `${new Date().toISOString()} ${out}`;
    }
    return out;
  };

  return {
    info(message, ...args) {
      console.log(format("info", message), ...args);
    },
    warn(message, ...args) {
      console.warn(format("warn", message), ...args);
    },
    error(message, ...args) {
      console.error(format("error", message), ...args);
    },
    debug(message, ...args) {
      // console.debug 是 console.log 别名，无法降噪；走 SATI_DEBUG 门控。
      debugLog(format("debug", message), ...args);
    },
  };
}

/** 默认单例（namespace="sati"），供大部分使用 `[sati]` 前缀的模块直接引用。 */
export const logger: Logger = createLogger("sati");
