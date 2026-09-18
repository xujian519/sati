import { createLogger } from "../telemetry/index.js";

const logger = createLogger("network");

/**
 * 代理不可达时的直连回退缝。
 *
 * 出网代理由 `src/cli/proxy.ts` 装配到 undici 的**全局 dispatcher**；核心
 * `networkFetch` 走裸 undici（不带 per-request dispatcher，否则会绕过
 * `proxy.url` / `proxy.noProxy` 的热重载），因此它自己拿不到代理状态。这里只放一个
 * 注册点，让代理层把"现在是否走代理 / 这个错误是不是代理连不上"告诉网络层，
 * 网络层不必反向依赖 cli 层。
 *
 * 没有注册（未经 `installGlobalProxy` 的进程，如多数单测）时行为不变：不做任何回退。
 */
export type ProxyConnectionFallback = {
  /** 当前是否处于"经代理出网"状态。 */
  isProxyActive(): boolean;
  /** 判断错误是否为"代理连不上"（连接建立阶段失败）。 */
  isProxyConnectionError(error: unknown): boolean;
  /** 直连 dispatcher（无代理），按需创建并复用。 */
  directDispatcher(): Promise<unknown>;
};

let fallback: ProxyConnectionFallback | undefined;

export function registerProxyConnectionFallback(next: ProxyConnectionFallback | undefined): void {
  fallback = next;
}

export function getProxyConnectionFallback(): ProxyConnectionFallback | undefined {
  return fallback;
}

/**
 * 执行 `attempt`；若因代理连不上而失败（代理未运行 / 连不上），用直连 dispatcher
 * 再试一次。仅在连接建立阶段失败时回退——HTTP 状态码错误、TLS 错误、超时都不触发，
 * 因为这些与"代理是否可达"无关。
 *
 * 直连也失败时抛**原始**错误：根因是代理侧，不该被直连的次级错误掩盖。
 */
export async function withDirectProxyFallback<T>(
  attempt: (dispatcher?: unknown) => Promise<T>,
  current: ProxyConnectionFallback | undefined = fallback,
): Promise<T> {
  try {
    return await attempt();
  } catch (error) {
    if (!current?.isProxyActive() || !current.isProxyConnectionError(error)) throw error;
    const dispatcher = await current.directDispatcher();
    logger.warn("Proxy unreachable, retrying direct");
    try {
      return await attempt(dispatcher);
    } catch {
      throw error;
    }
  }
}
