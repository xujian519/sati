/**
 * 环境变量解析统一层（P1 shared 收敛）。
 *
 * 只做「字符串 → 数值/布尔」的纯解析，不直接读取 process.env：
 * 品牌键（SATI_*）经 src/env.ts 的 brandEnv 读取后再传入；非品牌键
 * （LITELLM_* / ANALYTICS_* 等）由调用方在边界读取原始值后传入。
 *
 * CLI 参数校验（非法即 throw、带错误消息）与 env 读取（非法即 fallback）
 * 是不同关注点，不在此收敛——见 src/cli/commands/patentSearch.ts。
 */

/**
 * 解析为正整数（>0）。非法输入返回 undefined。
 * 语义对齐 createLocalGateway.readPositiveIntegerEnv：
 * parseInt + trim + finite + >0，Math.floor 兜底（parseInt 结果恒为整数）。
 */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.floor(parsed);
}

/** 解析为非负整数（>=0）。非法输入返回 undefined。 */
export function parseNonNegativeInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.floor(parsed);
}

/** env 读取：正整数解析失败时回退 fallback（对齐 telemetry/collector 原实现）。 */
export function readIntEnv(value: string | undefined, fallback: number): number {
  return parsePositiveInt(value) ?? fallback;
}

/** env 读取：非负整数解析失败时回退 fallback。 */
export function readNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  return parseNonNegativeInt(value) ?? fallback;
}

/**
 * env 布尔读取：0/false/off → false；1/true/on → true；其余回退 fallback。
 * 语义对齐 telemetry/collector.parseEnabledFlag 原实现。
 */
export function readBoolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === "0" || normalized === "false" || normalized === "off") return false;
  if (normalized === "1" || normalized === "true" || normalized === "on") return true;
  return fallback;
}

/**
 * 时长读取（原始 ms 字符串 × multiplier → ms）。
 * 语义对齐 streamModel.readOptionalPositiveEnvMs 原实现：用 Number()（
 * 兼容 "1e3" 科学计数法），非有限或 <=0 返回 undefined；空串视为未设置。
 */
export function readDurationEnvMs(raw: string | undefined, multiplier: number): number | undefined {
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value * multiplier;
}
