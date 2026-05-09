import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { DEFAULT_POLIT_HOME, resolvePolitHome } from "../../polit/index.js";

export type GatewayAuthTokenOptions = {
  politHome?: string;
  env?: Record<string, string | undefined>;
};

export function resolveGatewayTokenPath(options: GatewayAuthTokenOptions = {}): string {
  const politHome = options.politHome ?? resolvePolitHome(options.env ?? process.env);
  return resolve(politHome || DEFAULT_POLIT_HOME, "server-token");
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
