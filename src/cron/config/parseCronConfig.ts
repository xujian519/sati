import { isRecord } from "../../model/config/schema.js";
import type { PilotConfigDiagnostic } from "../../pilot/config/types.js";
import { isValidCronTimezone } from "../CronTimezone.js";

export type CronConfig = {
  enabled: boolean;
  timezone: string;
  maxConcurrentRuns: number;
  runTimeoutMinutes: number;
  /** 低谷时段窗口（小时，[startHour, endHour)，如 [2,6] 表示 02:00-05:59）。未配置则 offPeak 任务不生效。 */
  offPeakHours?: {
    startHour: number;
    endHour: number;
  };
};

export function defaultCronConfig(): CronConfig {
  return {
    enabled: true,
    timezone: "UTC",
    maxConcurrentRuns: 1,
    runTimeoutMinutes: 60,
  };
}

const ALLOWED_KEYS = new Set(["enabled", "timezone", "maxConcurrentRuns", "runTimeoutMinutes", "offPeakHours"]);

export function parseCronConfig(raw: unknown, diagnostics: PilotConfigDiagnostic[]): CronConfig | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!isRecord(raw)) {
    diagnostics.push({
      code: "CRON_CONFIG_INVALID",
      severity: "fatal",
      message: "cron config must be an object.",
      path: "cron",
      recoverable: false,
    });
    return undefined;
  }

  const result = defaultCronConfig();
  result.enabled = booleanField(raw, "enabled", result.enabled);
  const timezone = nonEmptyString(raw.timezone, result.timezone, "cron.timezone", diagnostics);
  if (isValidCronTimezone(timezone)) {
    result.timezone = timezone;
  } else {
    diagnostics.push({
      code: "CRON_TIMEZONE_INVALID",
      severity: "warning",
      message: `cron.timezone must be a valid IANA timezone; falling back to ${result.timezone}.`,
      path: "cron.timezone",
      recoverable: true,
    });
  }
  result.maxConcurrentRuns = positiveInteger(
    raw.maxConcurrentRuns,
    result.maxConcurrentRuns,
    "cron.maxConcurrentRuns",
    diagnostics,
  );
  result.runTimeoutMinutes = positiveInteger(
    raw.runTimeoutMinutes,
    result.runTimeoutMinutes,
    "cron.runTimeoutMinutes",
    diagnostics,
  );
  result.offPeakHours = offPeakHoursField(raw.offPeakHours, "cron.offPeakHours", diagnostics);

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      diagnostics.push({
        code: "CRON_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown cron config field ${key}.`,
        path: `cron.${key}`,
        recoverable: true,
      });
    }
  }

  return result;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

function nonEmptyString(value: unknown, fallback: string, path: string, diagnostics: PilotConfigDiagnostic[]): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  diagnostics.push({
    code: "CRON_STRING_INVALID",
    severity: "warning",
    message: `${path} must be a non-empty string; falling back to ${fallback}.`,
    path,
    recoverable: true,
  });
  return fallback;
}

function offPeakHoursField(
  value: unknown,
  path: string,
  diagnostics: PilotConfigDiagnostic[],
): CronConfig["offPeakHours"] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length !== 2) {
    diagnostics.push({
      code: "CRON_OFFPEAK_INVALID",
      severity: "warning",
      message: `${path} must be an array of two integers [startHour, endHour]; off-peak scheduling disabled.`,
      path,
      recoverable: true,
    });
    return undefined;
  }
  const [start, end] = value;
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isInteger(start) ||
    !Number.isInteger(end) ||
    start < 0 ||
    end < 0 ||
    start > 23 ||
    end > 24 ||
    start >= end
  ) {
    diagnostics.push({
      code: "CRON_OFFPEAK_INVALID",
      severity: "warning",
      message: `${path} must satisfy 0 <= startHour < endHour <= 24 (e.g. [2,6]); off-peak scheduling disabled.`,
      path,
      recoverable: true,
    });
    return undefined;
  }
  return { startHour: start, endHour: end };
}

function positiveInteger(value: unknown, fallback: number, path: string, diagnostics: PilotConfigDiagnostic[]): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    diagnostics.push({
      code: "CRON_NUMBER_INVALID",
      severity: "warning",
      message: `${path} must be a positive integer; falling back to ${fallback}.`,
      path,
      recoverable: true,
    });
    return fallback;
  }
  return value;
}
