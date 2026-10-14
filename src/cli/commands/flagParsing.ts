/**
 * CLI 子命令共用的旗标解析（P2.7 从 `cli/sati.ts` 原样搬出，逐 token 未改）。
 *
 * 约定：`--flag value` 形态；值缺失或以 `--` 开头一律视为「未提供」（`--flag --other`
 * 不把 `--other` 当值），故布尔开关与带值旗标可混排。
 */

export function readPort(argv: string[]): number | undefined {
  const index = argv.indexOf("--port");
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  const port = value ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isFinite(port) ? port : undefined;
}

export function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) {
    return undefined;
  }
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

export function readRepeatedStringFlag(argv: string[], flag: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value && !value.startsWith("--")) values.push(value);
  }
  return values;
}

export function readNumberFlag(argv: string[], flag: string): number | undefined {
  const value = readStringFlag(argv, flag);
  if (!value) {
    return undefined;
  }
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? number : undefined;
}

/** `channel:channelSessionId` 惯例的**第一个**冒号切分；无冒号或冒号在首字符时回落 `cli`。 */
export function inferChannelKey(sessionKey: string): string {
  const separator = sessionKey.indexOf(":");
  return separator > 0 ? sessionKey.slice(0, separator) : "cli";
}
