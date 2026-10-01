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

/**
 * WASM 后端的规模上限（DOT 源长度，UTF-16 码元）。
 *
 * WASM 渲染是**主线程同步调用、不可中断**：规模直接决定事件循环被占用的最坏时长，期间连
 * abort 信号都插不进去（子进程后端则有 deadline 与取消）。超过上限就**不交给它**，而是
 * fail-loud 并给出改走子进程后端或拆图的指引——这比"静默把进程占住几分钟"更诚实。
 *
 * 取值沿用 deepseek-harness 的 `WASM_MAX_HIERARCHICAL_DOT_CHARS`（层级图 64 000 码元）。
 * 本仓 `buildFigureDot` 只产层级图（dot 引擎），故取该档；**这不是本仓实测标定的值**，
 * 若要按本仓硬件重新标定，用 `scripts/figure-benchmark/renderer-compare.ts` 实测后调整。
 */
export const WASM_MAX_DOT_CHARS = 64_000;

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
    // 规模护栏先于实例化：大图不该走到布局阶段才发现无法取消（见 WASM_MAX_DOT_CHARS）。
    if (dot.length > WASM_MAX_DOT_CHARS) {
      throw new Error(
        `DOT 源 ${dot.length} 个字符超过 WASM 渲染上限 ${WASM_MAX_DOT_CHARS}（WASM 布局在主线程同步执行、` +
          `不可中断，大图会长时间占住事件循环且无法取消）；${WASM_FAILURE_HINT}，或把附图拆分为多幅`,
      );
    }
    const viz = await getInstance();
    return viz.renderString(dot, { format: "svg" });
  };
}
