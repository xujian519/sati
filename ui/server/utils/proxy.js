/**
 * Pure-JS port of `src/cli/proxy.ts` — installs a global undici
 * proxy agent so Node native `fetch()` and `WebSocket` honor
 * `SATI_PROXY` / `HTTPS_PROXY` / `HTTP_PROXY`. Node's native
 * fetch does NOT respect those env vars by default; this closes the
 * gap.
 *
 * Uses `EnvHttpProxyAgent` instead of bare `ProxyAgent` so that
 * `NO_PROXY` / `no_proxy` is honored. `127.0.0.1` and `localhost`
 * are always excluded — the gateway WebSocket lives on loopback and
 * must never be routed through an external proxy.
 *
 * Living in `ui/server/utils/` lets the express bridge run from
 * source without depending on `dist/src/cli/proxy.js`.
 */
import { Agent, EnvHttpProxyAgent, fetch as undiciFetch, setGlobalDispatcher } from "undici";

export const UNDICI_TRANSPORT_TIMEOUT_MS = 600_000;

function getProxyUrl(env = process.env) {
  // legacy(pre-rebrand): 兼容 PilotDeck 旧环境变量，升级用户迁移用
  return (
    env.SATI_PROXY || env.PILOTDECK_PROXY || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
  );
}

let dispatcherState;
let directFallbackAgent;
let fetchFallbackInstalled = false;

/**
 * Install a global undici dispatcher. Env proxy settings keep precedence over
 * the first config-based proxy install during startup.
 *
 * @param {string} [explicitUrl] Override the env-driven proxy URL.
 * @returns {string | undefined} The activated proxy URL.
 */
export function installGlobalProxy(explicitUrl, extraNoProxy) {
  const proxyUrl = explicitUrl ?? getProxyUrl();
  if (!proxyUrl) {
    applyDirectDispatcher();
    return undefined;
  }

  const source = explicitUrl ? "config" : "env";
  if (source === "config" && dispatcherState?.mode === "proxy" && dispatcherState.source === "env") {
    return undefined;
  }

  if (dispatcherState?.mode === "proxy" && dispatcherState.source === source && dispatcherState.proxyUrl === proxyUrl) {
    return undefined;
  }

  return applyGlobalProxy(proxyUrl, source, extraNoProxy);
}

export function getGlobalProxyStateForTesting() {
  return dispatcherState ? { ...dispatcherState } : undefined;
}

/** 连接建立阶段失败码：代理未运行时 undici 抛 ECONNREFUSED / UND_ERR_CONNECT_TIMEOUT。 */
const PROXY_CONNECTION_ERROR_CODES = new Set(["ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"]);

/**
 * 递归查找 error → cause 链中的连接类错误码。代理不可达时 Node fetch
 * 抛 `TypeError: fetch failed`，cause 为 `Error: connect ECONNREFUSED 127.0.0.1:9981`。
 */
export function isProxyConnectionError(error) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === "string" && PROXY_CONNECTION_ERROR_CODES.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

function describeFetchInput(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * 包装全局 fetch：代理模式下若连接建立失败（代理未运行/连不上），自动用直连
 * dispatcher 重试一次，实现"代理开与关都不影响"。仅在请求尚未发出（连接阶段
 * 失败）时回退，HTTP 状态码错误不受影响。
 */
function installFetchProxyFallback() {
  if (fetchFallbackInstalled) return;
  fetchFallbackInstalled = true;
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    if (dispatcherState?.mode !== "proxy") return nativeFetch(input, init);
    try {
      return await nativeFetch(input, init);
    } catch (error) {
      if (!isProxyConnectionError(error)) throw error;
      console.warn(`[proxy] Proxy unreachable, retrying direct (${describeFetchInput(input)})`);
      directFallbackAgent ??= new Agent(createLongTimeoutOptions());
      return undiciFetch(input, { ...(init ?? {}), dispatcher: directFallbackAgent });
    }
  };
}

export function reinstallGlobalProxy(proxyUrl, extraNoProxy) {
  if (!proxyUrl) {
    applyDirectDispatcher(true);
    return undefined;
  }
  return applyGlobalProxy(proxyUrl, "config", extraNoProxy);
}

function applyDirectDispatcher(logRemoval = false) {
  try {
    setGlobalDispatcher(new Agent(createLongTimeoutOptions()));
    dispatcherState = { mode: "direct" };
    if (logRemoval) {
      console.log("[proxy] Global fetch proxy removed");
    }
  } catch {
    // best effort
  }
}

function applyGlobalProxy(proxyUrl, source, extraNoProxy) {
  try {
    const noProxy = buildNoProxy(extraNoProxy);
    const agent = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
      ...createLongTimeoutOptions(),
    });
    setGlobalDispatcher(agent);
    dispatcherState = { mode: "proxy", source, proxyUrl, noProxy };
    installFetchProxyFallback();
    console.log(`[proxy] Global fetch proxy → ${proxyUrl} (noProxy: ${noProxy})`);
    return proxyUrl;
  } catch (error) {
    console.warn(
      `[proxy] Failed to install global proxy (${proxyUrl}):`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

function createLongTimeoutOptions() {
  return {
    headersTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
    bodyTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
  };
}

function buildNoProxy(extraNoProxy) {
  const userNoProxy = process.env.no_proxy || process.env.NO_PROXY || "";
  return [userNoProxy, extraNoProxy, "127.0.0.1", "localhost"].filter(Boolean).join(",");
}
