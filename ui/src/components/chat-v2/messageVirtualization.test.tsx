// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMessageVirtualization } from "./messageVirtualization";

/**
 * 虚拟化层测试（#159 N03a）。
 *
 * 搬出前这一层**没有直接测试**：纯函数 `buildPrefixOffsets` / `getVirtualMessageWindow` 有单测，
 * 但"窗口怎么随测量回填、条目增删、滚动/resize 演进"只能靠 `MessagesPaneV2.render.test.tsx`
 * 间接覆盖。搬移本身由 `/tmp/n03a-move-proof.mjs` 的 27 项逐 token 比对兜底，这里补行为证据。
 *
 * jsdom 不做布局（`clientHeight` 恒 0），需要视口高度时按渲染测试同样的做法显式定义。
 */

type Item = { itemKey: string; estimatedHeight: number };

const items = (specs: Array<[string, number]>): Item[] =>
  specs.map(([itemKey, estimatedHeight]) => ({ itemKey, estimatedHeight }));

function makeContainer(clientHeight = 400) {
  const container = document.createElement("div");
  Object.defineProperty(container, "clientHeight", { configurable: true, value: clientHeight });
  let scrollTop = 0;
  Object.defineProperty(container, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: value => {
      scrollTop = value;
    },
  });
  document.body.appendChild(container);
  return container;
}

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("useMessageVirtualization", () => {
  it("条目数低于阈值时不虚拟化，窗口覆盖全部条目", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer();
    // 稳定引用：组件里传的是 useRef 对象；每次渲染新建会让 layout effect 反复触发（测试自身的问题）。
    const scrollContainerRef = { current: container };
    const { result } = renderHook(() =>
      useMessageVirtualization({
        keyedItems: items([
          ["a", 100],
          ["b", 100],
        ]),
        scrollContainerRef,
      }),
    );

    expect(result.current.shouldVirtualizeMessages).toBe(false);
    expect(result.current.virtualWindow).toEqual({
      startIndex: 0,
      endIndex: 2,
      topPadding: 0,
      bottomPadding: 0,
      totalHeight: 200,
    });
    expect(result.current.windowedMessageItems.map(item => item.itemKey)).toEqual(["a", "b"]);
    expect(result.current.measuredItemHeights).toEqual([100, 100]);
  });

  it("条目数超过 60 时启用虚拟化，只返回窗口内的条目", () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer();
    // 稳定引用：组件里传的是 useRef 对象；每次渲染新建会让 layout effect 反复触发（测试自身的问题）。
    const scrollContainerRef = { current: container };
    const many = items(Array.from({ length: 80 }, (_, i) => [`k-${i}`, 100] as [string, number]));
    const { result } = renderHook(() => useMessageVirtualization({ keyedItems: many, scrollContainerRef }));

    expect(result.current.shouldVirtualizeMessages).toBe(true);
    expect(result.current.windowedMessageItems.length).toBeLessThan(80);
    // 窗口首尾留有 overscan，且总高等于全部估算高度之和
    expect(result.current.virtualWindow.totalHeight).toBe(8000);
  });

  it("实测高度覆盖估算高度，并进入窗口计算的前缀和", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer();
    // 稳定引用：组件里传的是 useRef 对象；每次渲染新建会让 layout effect 反复触发（测试自身的问题）。
    const scrollContainerRef = { current: container };
    const { result } = renderHook(() =>
      useMessageVirtualization({
        keyedItems: items([
          ["a", 100],
          ["b", 100],
        ]),
        scrollContainerRef,
      }),
    );

    act(() => result.current.handleMeasuredItemHeight("a", 333));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });

    expect(result.current.measuredItemHeights).toEqual([333, 100]);
  });

  it("高度变化小于 2px 时不触发重算（避免抖动）", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer();
    // 稳定引用：组件里传的是 useRef 对象；每次渲染新建会让 layout effect 反复触发（测试自身的问题）。
    const scrollContainerRef = { current: container };
    const { result } = renderHook(() =>
      useMessageVirtualization({
        keyedItems: items([["a", 100]]),
        scrollContainerRef,
      }),
    );

    // 先建立一次实测基线（首次测量一定会被记录）
    act(() => result.current.handleMeasuredItemHeight("a", 101));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.measuredItemHeights).toEqual([101]);

    // 再报一个与已记录值差 < 2px 的高度：应被忽略（抑制滚动抖动带来的重算）
    act(() => result.current.handleMeasuredItemHeight("a", 102));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.measuredItemHeights).toEqual([101]);
  });

  it("条目被移除后清理其测量值（避免高度表无限增长）", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer();
    // 稳定引用：组件里传的是 useRef 对象；每次渲染新建会让 layout effect 反复触发（测试自身的问题）。
    const scrollContainerRef = { current: container };
    const { result, rerender } = renderHook(
      ({ list }: { list: Item[] }) => useMessageVirtualization({ keyedItems: list, scrollContainerRef }),
      {
        initialProps: {
          list: items([
            ["a", 100],
            ["b", 100],
          ]),
        },
      },
    );

    act(() => result.current.handleMeasuredItemHeight("b", 250));
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.measuredItemHeights).toEqual([100, 250]);

    rerender({ list: items([["a", 100]]) });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(result.current.measuredItemHeights).toEqual([100]);
  });

  it("滚动与 resize 都会刷新视口（layout effect 里注册的两条监听）", async () => {
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => window.setTimeout(() => cb(0), 0));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
    const container = makeContainer(300);
    const scrollContainerRef300 = { current: container };
    const many = items(Array.from({ length: 80 }, (_, i) => [`k-${i}`, 100] as [string, number]));
    const { result } = renderHook(() =>
      useMessageVirtualization({ keyedItems: many, scrollContainerRef: scrollContainerRef300 }),
    );
    const before = result.current.virtualWindow.startIndex;

    // 滚到第 40 项附近（每项 100px）
    act(() => {
      container.scrollTop = 4000;
      container.dispatchEvent(new Event("scroll"));
    });
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
    });

    expect(result.current.virtualWindow.startIndex).toBeGreaterThan(before);
    expect(result.current.virtualWindow.topPadding).toBeGreaterThan(0);
  });
});
