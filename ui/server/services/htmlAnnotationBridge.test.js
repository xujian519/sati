// @vitest-environment jsdom
/**
 * H2 注入桥接的判据：
 * - 字节注入的落点与保真（doctype/BOM/无 doctype/GBK 字节不被转码）；
 * - 桥接快照的结构（selector 语法、叶子优先、bbox 文档坐标）与 revision 新鲜度；
 * - message 过滤（channel + nonce + remeasure）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HTML_ANNOTATION_CHANNEL,
  HTML_ANNOTATION_MAX_SELECTOR_CHARS,
  buildHtmlAnnotationBridgeScript,
  injectHtmlAnnotationBridge,
} from "./htmlAnnotationBridge.js";

describe("bridge injection bytes", () => {
  it("pins the channel name (父页常量必须与此一致)", () => {
    expect(HTML_ANNOTATION_CHANNEL).toBe("sati-html-annotation");
  });

  it("injects right after the doctype and keeps every other byte intact", () => {
    const source = Buffer.from("<!doctype html>\n<html><body><p>x</p></body></html>\n", "utf8");
    const { bytes, mode } = injectHtmlAnnotationBridge(source, "window.__probe=1;");

    expect(mode).toBe("doctype");
    const text = bytes.toString("utf8");
    expect(text.startsWith("<!doctype html><script>window.__probe=1;</script>")).toBe(true);
    // 去掉注入片段后与源逐字节一致。
    expect(text.replace("<script>window.__probe=1;</script>", "")).toBe(source.toString("utf8"));
  });

  it("handles BOM and uppercase doctype, and does not touch a `<head>` in a comment", () => {
    const source = Buffer.from("\uFEFF<!DOCTYPE html>\n<!-- <head> -->\n<html></html>", "utf8");
    const { bytes, mode } = injectHtmlAnnotationBridge(source, "s;");

    expect(mode).toBe("doctype");
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(true);
    const text = bytes.toString("utf8");
    expect(text.indexOf("<script>s;</script>")).toBeGreaterThan(-1);
    expect(text.indexOf("<script>")).toBeLessThan(text.indexOf("<!-- <head> -->"));
    expect(text).toContain("<!-- <head> -->");
  });

  it("prepends when there is no doctype (记录在案的分叉)", () => {
    const source = Buffer.from("<html><body>plain</body></html>", "utf8");
    const { bytes, mode } = injectHtmlAnnotationBridge(source, "s;");

    expect(mode).toBe("prepend");
    expect(bytes.toString("utf8")).toBe("<script>s;</script><html><body>plain</body></html>");
  });

  it("keeps non-UTF-8 bytes byte-identical (GBK 不被转码)", () => {
    const gbkBody = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // “你好”（GBK）
    const source = Buffer.concat([Buffer.from("<!doctype html><p>", "latin1"), gbkBody, Buffer.from("</p>", "latin1")]);
    const { bytes } = injectHtmlAnnotationBridge(source, "s;");

    expect(bytes.includes(gbkBody)).toBe(true);
    expect(bytes.length).toBe(source.length + "<script>s;</script>".length);
  });

  it("refuses a non-ASCII script (byte splicing assumes ASCII)", () => {
    expect(() => buildHtmlAnnotationBridgeScript({ nonce: "n1" })).not.toThrow();
    expect(buildHtmlAnnotationBridgeScript({ nonce: "n1" })).toMatch(/^[\x09\x0a\x0d\x20-\x7e]+$/);
  });
});

/** 在 jsdom 里执行桥接脚本（jsdom 无布局：给所有元素一个 10×10 的盒子）。 */
let bridgeCounter = 0;
function runBridge(options = {}) {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    if (this.classList?.contains("invisible")) return { left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0 };
    return { left: 5, top: 6, width: 10, height: 10, right: 15, bottom: 16 };
  };
  const posted = [];
  const spy = vi.spyOn(window, "postMessage").mockImplementation((message, _target) => {
    posted.push(message);
  });
  // 每个用例一个唯一 nonce：同一文件里前序用例的桥接仍然活着，它们对新 DOM 变更发出的
  // 消息会落进本用例的 spy；按 nonce 过滤，只断言本桥接的消息。
  const nonce = `n${(bridgeCounter += 1)}`;
  const script = buildHtmlAnnotationBridgeScript({ nonce, throttleMs: 10, ...options });
  (0, eval)(script);
  return {
    nonce,
    posted,
    spy,
    mine: () => posted.filter(message => message && message.nonce === nonce),
    restore() {
      Element.prototype.getBoundingClientRect = original;
      spy.mockRestore();
    },
  };
}

describe("bridge snapshots", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("posts a snapshot with dsh-style selectors and document coordinates", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="top"><p class="a">hello</p><span>b</span><i class="invisible">hidden</i></div>';
    const bridge = runBridge();
    try {
      await vi.advanceTimersByTimeAsync(20);
      expect(bridge.mine().length).toBeGreaterThan(0);
      const message = bridge.mine().at(-1);
      expect(message.channel).toBe(HTML_ANNOTATION_CHANNEL);
      expect(message.nonce).toBe(bridge.nonce);
      expect(message.type).toBe("snapshot");
      expect(message.truncated).toBe(false);
      // 文档坐标基准：快照带滚动偏移（jsdom 里为 0）。
      expect(message.scroll).toEqual([0, 0]);

      const p = message.elements.find(element => element.tag === "p");
      expect(p.selector).toBe("#top > p:nth-of-type(1)");
      // bbox 是文档坐标（rect + scroll）；jsdom 里 scroll 为 0。
      expect(p.bbox).toEqual([5, 6, 10, 10]);
      // 零尺寸元素被排除。
      expect(message.elements.some(element => element.text === "hidden")).toBe(false);
      // 逐一断言：非截断场景下面板里的元素数 = 有盒子的元素数（div/p/span；body 不在 `*` 列表内）。
      expect(message.elements.length).toBe(3);
    } finally {
      bridge.restore();
    }
  });

  it("bumps revision on mutations and answers a remeasure for its own nonce only", async () => {
    // 真实计时器：jsdom 的 MutationObserver 投递发生在微任务队列，fake timers 不驱动它。
    document.body.innerHTML = "<p>one</p>";
    const bridge = runBridge();
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      await wait(60);
      const first = bridge.mine().at(-1);
      expect(first?.type).toBe("snapshot");

      document.body.insertAdjacentHTML("beforeend", "<b>two</b>");
      await wait(80);
      const afterMutation = bridge.mine().at(-1);
      expect(afterMutation.revision).toBeGreaterThan(first.revision);

      window.dispatchEvent(
        new MessageEvent("message", { data: { channel: HTML_ANNOTATION_CHANNEL, nonce: "other", type: "remeasure" } }),
      );
      await wait(60);
      expect(bridge.mine().at(-1).revision).toBe(afterMutation.revision);

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: HTML_ANNOTATION_CHANNEL, nonce: bridge.nonce, type: "remeasure" },
        }),
      );
      await wait(60);
      expect(bridge.mine().at(-1).revision).toBeGreaterThan(afterMutation.revision);
    } finally {
      bridge.restore();
    }
  });

  it("falls back to nth-of-type for an id a CSS selector cannot carry", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<div id="a b"><p>x</p></div>';
    const bridge = runBridge();
    try {
      await vi.advanceTimersByTimeAsync(20);
      const p = bridge
        .mine()
        .at(-1)
        .elements.find(element => element.tag === "p");
      expect(p.selector).toBe("body > div:nth-of-type(1) > p:nth-of-type(1)");
    } finally {
      bridge.restore();
    }
  });

  it("omits a selector longer than the shared cap", async () => {
    vi.useFakeTimers();
    // 构造一条超过上限的路径：深层嵌套 div（每层 nth-of-type(1)）。
    const depth = Math.ceil(HTML_ANNOTATION_MAX_SELECTOR_CHARS / "div:nth-of-type(1) > ".length) + 4;
    document.body.innerHTML = `${"<div>".repeat(depth)}<p>x</p>${"</div>".repeat(depth)}`;
    const bridge = runBridge();
    try {
      await vi.advanceTimersByTimeAsync(20);
      const p = bridge
        .mine()
        .at(-1)
        .elements.find(element => element.tag === "p");
      expect(p.selector).toBeUndefined();
    } finally {
      bridge.restore();
    }
  });

  it("truncates the element list at the shared cap and flags it", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = `<div>${"<span>x</span>".repeat(2100)}</div>`;
    const bridge = runBridge();
    try {
      await vi.advanceTimersByTimeAsync(20);
      const message = bridge.mine().at(-1);
      expect(message.truncated).toBe(true);
      expect(message.elements.length).toBe(2000);
    } finally {
      bridge.restore();
    }
  });

  it("posts a lightweight scroll update on scroll events (与快照分开，滚动时不重发元素表)", async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    document.body.innerHTML = "<p>x</p>";
    const bridge = runBridge();
    try {
      await wait(40);
      window.dispatchEvent(new Event("scroll"));
      await wait(140);
      const scrollMessages = bridge.mine().filter(message => message.type === "scroll");
      expect(scrollMessages.length).toBeGreaterThan(0);
      expect(scrollMessages.at(-1).scroll).toEqual([0, 0]);
      // 快照消息不因滚动重复发送（只有轻量 scroll 消息）。
      const snapshots = bridge.mine().filter(message => message.type === "snapshot");
      expect(snapshots.length).toBe(1);
    } finally {
      bridge.restore();
    }
  });

  it("clamps scrollBy to its own nonce and to the shared step limit", () => {
    document.body.innerHTML = "<p>x</p>";
    const bridge = runBridge();
    const scrollBy = vi.spyOn(window, "scrollBy").mockImplementation(() => {});
    try {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: HTML_ANNOTATION_CHANNEL, nonce: "other", type: "scrollBy", dx: 10, dy: 20 },
        }),
      );
      expect(scrollBy).not.toHaveBeenCalled();

      window.dispatchEvent(
        new MessageEvent("message", {
          data: { channel: HTML_ANNOTATION_CHANNEL, nonce: bridge.nonce, type: "scrollBy", dx: 999999, dy: -999999 },
        }),
      );
      expect(scrollBy).toHaveBeenCalledWith(10000, -10000);
    } finally {
      bridge.restore();
    }
  });

  it("posts to the parent with targetOrigin `*` (沙箱不透明源下唯一可行的形态)", async () => {
    vi.useFakeTimers();
    document.body.innerHTML = "<p>x</p>";
    const bridge = runBridge();
    try {
      await vi.advanceTimersByTimeAsync(20);
      const snapshotCall = bridge.spy.mock.calls.find(
        call => call[0]?.type === "snapshot" && call[0]?.nonce === bridge.nonce,
      );
      expect(snapshotCall).toBeDefined();
      expect(snapshotCall[1]).toBe("*");
    } finally {
      bridge.restore();
    }
  });
});
