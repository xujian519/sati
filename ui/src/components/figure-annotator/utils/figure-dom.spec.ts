import { describe, expect, it } from "vitest";
import { anchorAtPoint, figureSvgMarkup, parseFigureSvg, svgIntrinsicSize } from "./figure-dom";

/** jsdom 不算布局，命中测试依赖的矩形必须自己打桩。 */
function stubRect(element: Element, rect: { left: number; top: number; width: number; height: number }): void {
  Object.defineProperty(element, "getBoundingClientRect", {
    configurable: true,
    value: () => ({
      ...rect,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      x: rect.left,
      y: rect.top,
      toJSON: () => rect,
    }),
  });
}

/** 内置渲染器的形态：节点分组带 `id="n-<nodeId>"` 与 `data-ref`。 */
const FIGURE = `<svg xmlns="http://www.w3.org/2000/svg" data-figure-no="1" width="100" height="100">
  <g id="n-n3" data-ref="34"><rect x="10" y="10" width="40" height="20" fill="none"/><text x="20" y="25">滑套</text></g>
  <text x="70" y="80">导柱</text>
</svg>`;

describe("figure DOM", () => {
  it("rejects text that is not SVG", () => {
    expect(parseFigureSvg("not svg at all")).toBeUndefined();
    expect(parseFigureSvg("<html><body/></html>")).toBeUndefined();
  });

  it("strips scripts, handlers and external references before inlining", () => {
    const root = parseFigureSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <script>alert(1)</script>
      <foreignObject><div/></foreignObject>
      <a href="javascript:alert(1)" onclick="alert(2)"><rect width="5" height="5"/></a>
      <image href="https://evil.example/x.png" width="1" height="1"/>
      <image href="data:image/png;base64,AA" width="1" height="1"/>
    </svg>`);
    expect(root).toBeDefined();
    const markup = figureSvgMarkup(root!);
    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("foreignObject");
    expect(markup).not.toContain("onclick");
    expect(markup).not.toContain("javascript:");
    expect(markup).not.toContain("evil.example");
    expect(markup).toContain("data:image/png;base64,AA");
  });

  it("reads the intrinsic size from attributes, then the viewBox, then defaults", () => {
    expect(svgIntrinsicSize(parseFigureSvg('<svg width="12" height="7"/>')!)).toEqual({ width: 12, height: 7 });
    expect(svgIntrinsicSize(parseFigureSvg('<svg viewBox="0 0 30 40"/>')!)).toEqual({ width: 30, height: 40 });
    expect(svgIntrinsicSize(parseFigureSvg("<svg/>")!)).toEqual({ width: 800, height: 600 });
    expect(svgIntrinsicSize(parseFigureSvg('<svg width="0" height="-4"/>')!)).toEqual({ width: 800, height: 600 });
  });

  it("scrubs the CSS surfaces that would reach outside the figure", () => {
    const root = parseFigureSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">
      <style>@import url("https://evil.example/x.css");
        .a{fill:url(https://evil.example/y.svg#g);position:fixed;z-index:99;background-image:url(#keep)}</style>
      <rect class="a" width="5" height="5"
        style="fill:url('https://evil.example/z.svg#g');cursor:url(https://evil.example/c.svg), auto"
        fill="url(https://evil.example/w.svg#g)" filter="url(#local)"/>
    </svg>`);
    expect(root).toBeDefined();
    const markup = figureSvgMarkup(root!);
    // 外联引用一律断掉（CSS 里的 url() 与 @import 会真的发请求）。
    expect(markup).not.toContain("evil.example");
    expect(markup).not.toContain("@import");
    // 图内锚点不能误伤。
    expect(markup).toContain("url(#keep)");
    expect(markup).toContain("url(#local)");
    // 定位声明整条去掉：附图靠坐标画，`position:fixed` 能把界面盖住。
    expect(markup).not.toContain("position");
    expect(markup).not.toContain("z-index");
  });

  it("keeps the inline bytes and the class rules the figure needs to render", () => {
    const root = parseFigureSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><style>.box{fill:#00ff00}</style><image href="data:image/png;base64,AA" width="1" height="1"/></svg>',
    );
    const markup = figureSvgMarkup(root!);
    expect(markup).toContain("data:image/png;base64,AA");
    expect(markup).toContain(".box{fill:#00ff00}");
  });

  it("anchors inside the shadow root the figure is inlined into", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const root = parseFigureSvg(FIGURE)!;
    shadow.append(root);
    const group = root.querySelector("g")!;
    stubRect(host, { left: 0, top: 0, width: 100, height: 100 });
    stubRect(root, { left: 0, top: 0, width: 100, height: 100 });
    stubRect(group, { left: 10, top: 10, width: 40, height: 20 });
    stubRect(group.querySelector("rect")!, { left: 10, top: 10, width: 40, height: 20 });

    expect(anchorAtPoint(host, 30, 20, 1, 1)).toMatchObject({ nodeId: "n3", ref: "34", bbox: [10, 10, 40, 20] });
  });

  it("anchors a point to the machine-readable node identity", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = parseFigureSvg(FIGURE)!;
    container.append(root);
    const group = root.querySelector("g")!;
    const rect = root.querySelector("rect")!;
    const nodeLabel = group.querySelector("text")!;
    const freeLabel = root.querySelectorAll("text")[1]!;

    stubRect(container, { left: 0, top: 0, width: 100, height: 100 });
    stubRect(root, { left: 0, top: 0, width: 100, height: 100 });
    stubRect(group, { left: 10, top: 10, width: 40, height: 20 });
    stubRect(rect, { left: 10, top: 10, width: 40, height: 20 });
    stubRect(nodeLabel, { left: 20, top: 18, width: 20, height: 10 });
    stubRect(freeLabel, { left: 60, top: 70, width: 30, height: 12 });

    // 命中节点内部 → 重指到带 id/data-ref 的分组，并把 nodeId 与标号一并带出。
    expect(anchorAtPoint(container, 30, 20, 1, 1)).toMatchObject({
      tag: "g",
      id: "n-n3",
      nodeId: "n3",
      ref: "34",
      bbox: [10, 10, 40, 20],
    });
    // 命中自由文字 → 落在 <text> 上，没有 nodeId/ref。
    const label = anchorAtPoint(container, 70, 75, 1, 1);
    expect(label).toMatchObject({ tag: "text", text: "导柱" });
    expect(label?.nodeId).toBeUndefined();
    // 谁也没命中 → 无锚定。
    expect(anchorAtPoint(container, 5, 95, 1, 1)).toBeUndefined();
  });

  it("scales the reported box into figure pixels", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = parseFigureSvg(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><g id="n-a"><rect width="50" height="50"/></g></svg>',
    )!;
    container.append(root);
    const group = root.querySelector("g")!;
    stubRect(container, { left: 0, top: 0, width: 200, height: 200 });
    stubRect(group, { left: 0, top: 0, width: 100, height: 100 });
    stubRect(group.querySelector("rect")!, { left: 0, top: 0, width: 100, height: 100 });
    expect(anchorAtPoint(container, 10, 10, 2, 2)?.bbox).toEqual([0, 0, 200, 200]);
  });

  it("answers undefined when the container holds no figure", () => {
    expect(anchorAtPoint(document.createElement("div"), 1, 1, 1, 1)).toBeUndefined();
  });
});
