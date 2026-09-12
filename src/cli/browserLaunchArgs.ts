/**
 * browser 启动参数与代理解析（2026-09-11 由 createLocalGateway.ts 抽出，architecture-fix-plan P4a 第一刀）。
 *
 * 逐字迁移，行为不变；组合根（createLocalGateway）仅保留编排与装配调用。
 */

import { ENV_KEY, brandEnv } from "../env.js";
import { parsePositiveInt } from "../shared/env/index.js";
import { type PilotProxyConfig } from "../pilot/index.js";

export function buildBrowserUseArgs(
  baseArgs: string[],
  outputDir: string,
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): string[] {
  let args = [...baseArgs];
  args = appendCliArg(args, "--output-dir", outputDir);
  args = appendCliArg(
    args,
    "--timeout-action",
    String(
      parsePositiveInt(brandEnv(env, ENV_KEY.BROWSER_TIMEOUT_ACTION_MS)) ??
        parsePositiveInt(brandEnv(env, ENV_KEY.BROWSER_ACTION_TIMEOUT_MS)) ??
        DEFAULT_BROWSER_ACTION_TIMEOUT_MS,
    ),
  );
  args = appendCliArg(
    args,
    "--timeout-navigation",
    String(
      parsePositiveInt(brandEnv(env, ENV_KEY.BROWSER_TIMEOUT_NAVIGATION_MS)) ??
        parsePositiveInt(brandEnv(env, ENV_KEY.BROWSER_NAVIGATION_TIMEOUT_MS)) ??
        DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS,
    ),
  );

  const proxy = resolveBrowserProxyServer(env, configProxy);
  if (proxy) {
    args = appendCliArg(args, "--proxy-server", proxy.server);
    const proxyBypass = resolveBrowserProxyBypass(env, configProxy, proxy.source);
    if (proxyBypass) {
      args = appendCliArg(args, "--proxy-bypass", proxyBypass);
    }
  }
  return args;
}

export function appendCliArg(args: string[], flag: string, value: string): string[] {
  if (args.includes(flag) || args.some(arg => arg.startsWith(`${flag}=`))) {
    return args;
  }
  return [...args, flag, value];
}

export function resolveBrowserProxyServer(
  env: Record<string, string | undefined>,
  configProxy?: PilotProxyConfig,
): { server: string; source: BrowserProxySource } | undefined {
  const explicit = cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_SERVER));
  if (explicit) {
    if (/^(0|false|off|none|direct)$/i.test(explicit)) return undefined;
    return { server: explicit, source: "browser-env" };
  }
  if (/^(1|true|on|yes)$/i.test(cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_FROM_ENV)) ?? "")) {
    const envProxy =
      cleanEnvValue(brandEnv(env, ENV_KEY.PROXY)) ??
      cleanEnvValue(env.https_proxy) ??
      cleanEnvValue(env.HTTPS_PROXY) ??
      cleanEnvValue(env.http_proxy) ??
      cleanEnvValue(env.HTTP_PROXY);
    if (envProxy) return { server: envProxy, source: "env" };
  }
  const configUrl = cleanEnvValue(configProxy?.url);
  return configUrl ? { server: configUrl, source: "config" } : undefined;
}

export function resolveBrowserProxyBypass(
  env: Record<string, string | undefined>,
  configProxy: PilotProxyConfig | undefined,
  proxySource: BrowserProxySource,
): string {
  const explicit = cleanEnvValue(brandEnv(env, ENV_KEY.BROWSER_PROXY_BYPASS));
  if (explicit) return explicit;
  const noProxy = cleanEnvValue(env.no_proxy) ?? cleanEnvValue(env.NO_PROXY);
  const configNoProxy = proxySource === "config" ? cleanEnvValue(configProxy?.noProxy) : undefined;
  return [noProxy, configNoProxy, "localhost", "127.0.0.1"].filter(Boolean).join(",");
}

export function cleanEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * 把插件贡献中的角色 skill（type: "role"）同步进子代理注册表。
 * 先清除此前注册的角色（防残留，直接遍历注册表键，避免同名角色被
 * 内置预设过滤而漏清理），再注册当前全部角色。
 * 内置 4 个预设（SUBAGENT_DEFINITIONS）不受影响。
 */

type BrowserProxySource = "browser-env" | "env" | "config";

const DEFAULT_BROWSER_ACTION_TIMEOUT_MS = 30_000;

const DEFAULT_BROWSER_NAVIGATION_TIMEOUT_MS = 90_000;
