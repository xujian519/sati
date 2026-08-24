import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
// 直接从 shared/paths 取 pilot 路径常量，避免经 pilot/index 间接引用——
// pilot/index → PilotConfigStore → telemetry/index → telemetry/context →
// gateway/authToken 会形成静态循环，Vite SSR 转译下 barrel 部分初始化导致
// createLogger 绑定未就绪（UI 测试 createLogger is not a function）。
import { DEFAULT_SATI_HOME, resolvePilotHome } from "../../shared/paths/index.js";

export type GatewayAuthTokenOptions = {
  pilotHome?: string;
  env?: Record<string, string | undefined>;
};

export function resolveGatewayTokenPath(options: GatewayAuthTokenOptions = {}): string {
  const pilotHome = options.pilotHome ?? resolvePilotHome(options.env ?? process.env);
  return resolve(pilotHome || DEFAULT_SATI_HOME, "server-token");
}

export async function readGatewayAuthToken(options: GatewayAuthTokenOptions = {}): Promise<string | undefined> {
  const tokenPath = resolveGatewayTokenPath(options);
  if (!existsSync(tokenPath)) {
    return undefined;
  }
  const token = (await readFile(tokenPath, "utf8")).trim();
  return token || undefined;
}

export async function ensureGatewayAuthToken(options: GatewayAuthTokenOptions = {}): Promise<{
  token: string;
  tokenPath: string;
}> {
  const tokenPath = resolveGatewayTokenPath(options);
  const existing = await readGatewayAuthToken(options);
  if (existing) {
    return { token: existing, tokenPath };
  }

  const token = randomBytes(32).toString("base64url");
  await mkdir(dirname(tokenPath), { recursive: true, mode: 0o700 });
  await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
  return { token, tokenPath };
}
