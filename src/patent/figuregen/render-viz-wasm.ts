/**
 * src/patent/figuregen — Graphviz WASM 渲染后端（`@viz-js/viz`）。
 *
 * 与 render-graphviz.ts 的子进程后端产出同构 SVG（同一 buildFigureDot 源、同一加工链），
 * 差别只在**谁来跑布局**：系统 `dot` 二进制 vs 打包进应用的 WASM。定位是让没有系统
 * graphviz 的机器（含桌面端分发）也能用 graphviz 布局，而不必先 `brew install`。
 *
 * 三条纪律：
 * 1. **惰性加载**：`@viz-js/viz` 只在真正渲染时经动态 import 载入，不进进程启动路径
 *    （它是 ~1.2MB 的实例化期 WASM，绝大多数会话用不到内置渲染器以外的后端）；
 * 2. **实例只建一次**：WASM 实例化有固定开销，成功后缓存复用；**创建失败不缓存**，
 *    否则一次瞬时失败会把后续所有渲染都钉死（下次仍可重试）；
 * 3. **失败 fail-loud**：加载/实例化失败一律抛错并引导改用内置渲染器或系统 graphviz，
 *    **绝不静默回退**到内置渲染器（静默回退会让"用 graphviz 布局"的意图被悄悄违背）。
 */

import { FIGURE_RENDERER_ENV, type DotRunner } from "./render-graphviz.js";

/** 动态 import 的模块外形（用 unknown 收窄，避免对 @viz-js/viz 的类型产生编译期强耦合）。 */
export type VizLoader = () => Promise<unknown>;

/** Viz 实例：本模块只依赖 renderString。 */
type VizInstance = { renderString: (input: string, options: { format: string }) => string };

/** 惰性载入真实模块（不进启动路径）。 */
const loadVizModule: VizLoader = () => import("@viz-js/viz");

/** 失败引导：WASM 不可用时用户的两条退路。 */
const WASM_FAILURE_HINT = `请改用内置渲染器（${FIGURE_RENDERER_ENV}=builtin）或系统 graphviz（brew install graphviz）`;

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 模块外形守卫：@viz-js/viz 暴露异步的 instance()。 */
function isVizModule(value: unknown): value is { instance: () => Promise<unknown> } {
  return (
    typeof value === "object" && value !== null && typeof (value as { instance?: unknown }).instance === "function"
  );
}

/** 实例外形守卫：实例必须提供 renderString。 */
function isVizInstance(value: unknown): value is VizInstance {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { renderString?: unknown }).renderString === "function"
  );
}

/**
 * 构造 WASM dot 后端。实例惰性创建并缓存；加载/实例化失败抛带引导文案的错误、且不落缓存。
 * 渲染错误（如非法 DOT）原样上抛，不包装（调用方已 fail-closed）。
 */
export function createWasmDotRunner(deps: { loadViz?: VizLoader } = {}): DotRunner {
  const loadViz = deps.loadViz ?? loadVizModule;
  let instancePromise: Promise<VizInstance> | undefined;

  const getInstance = async (): Promise<VizInstance> => {
    instancePromise ??= (async () => {
      let mod: unknown;
      try {
        mod = await loadViz();
      } catch (err) {
        throw new Error(`WASM 版 graphviz 不可用（@viz-js/viz 加载失败: ${describeError(err)}）；${WASM_FAILURE_HINT}`);
      }
      if (!isVizModule(mod)) {
        throw new Error(`WASM 版 graphviz 不可用（@viz-js/viz 模块缺少 instance()）；${WASM_FAILURE_HINT}`);
      }
      let instance: unknown;
      try {
        instance = await mod.instance();
      } catch (err) {
        throw new Error(
          `WASM 版 graphviz 不可用（@viz-js/viz 实例化失败: ${describeError(err)}）；${WASM_FAILURE_HINT}`,
        );
      }
      if (!isVizInstance(instance)) {
        throw new Error(`WASM 版 graphviz 不可用（@viz-js/viz 实例缺少 renderString()）；${WASM_FAILURE_HINT}`);
      }
      return instance;
    })();
    try {
      return await instancePromise;
    } catch (err) {
      // 失败不缓存：瞬时失败（如临时 IO）不应把后续渲染全部钉死。
      instancePromise = undefined;
      throw err;
    }
  };

  return async (dot: string, signal?: AbortSignal) => {
    if (signal?.aborted === true) {
      throw new Error("WASM graphviz 渲染已取消（signal 已 abort）");
    }
    const viz = await getInstance();
    return viz.renderString(dot, { format: "svg" });
  };
}
