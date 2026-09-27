import { describe, expect, it } from "vitest";
import { regionCaptureOptions } from "./regionCapture";

describe("region capture options", () => {
  it("keeps foreignObject rendering on, so oklch colours do not break the capture", () => {
    // 防回退：这个开关一被删，四条区域引用通路（栅格图 / PDF / 表格 / 附图）会同时失效——
    // html2canvas 自带的逐样式渲染器解析不了 Tailwind 4 的 oklch 颜色（#576）。
    expect(regionCaptureOptions(1).foreignObjectRendering).toBe(true);
  });

  it("clamps the pixel ratio into the 1x-2x band and always paints white", () => {
    expect(regionCaptureOptions(3).scale).toBe(2);
    expect(regionCaptureOptions(0).scale).toBe(1);
    expect(regionCaptureOptions(Number.NaN).scale).toBe(1);
    expect(regionCaptureOptions(1.5).scale).toBe(1.5);
    expect(regionCaptureOptions(1).backgroundColor).toBe("#ffffff");
  });
});
