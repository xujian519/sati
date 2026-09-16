import { describe, expect, it } from "vitest";
import { resolveCompactBoundaryTone } from "./compactBoundaryTone";

/**
 * 压缩边界行的终态色调（上游 #570 移植）。
 *
 * 关键判据是「降级/中断不得显示成成功」，以及「读不到终态不得反推为失败」——
 * 旧 transcript 记录不带终态字段，误判会让所有历史压缩行都变琥珀色。
 */
describe("resolveCompactBoundaryTone", () => {
  it("成功为 ok", () => {
    expect(resolveCompactBoundaryTone({ compactState: "success", compactSummarySucceeded: true })).toBe("ok");
  });

  it("读不到终态视为成功（旧记录兼容）", () => {
    expect(resolveCompactBoundaryTone({})).toBe("ok");
  });

  it("摘要降级为 degraded（历史投影只给 summarySucceeded）", () => {
    expect(resolveCompactBoundaryTone({ compactSummarySucceeded: false })).toBe("degraded");
  });

  it("fallback 终态为 degraded（实时帧来源）", () => {
    expect(resolveCompactBoundaryTone({ compactState: "fallback" })).toBe("degraded");
  });

  it("中断单独一档（与摘要失败区分）", () => {
    expect(resolveCompactBoundaryTone({ compactState: "cancelled", compactSummarySucceeded: false })).toBe("cancelled");
  });

  it("failed 归入 degraded（正常不落成边界行，防投影来源变化）", () => {
    expect(resolveCompactBoundaryTone({ compactState: "failed" })).toBe("degraded");
  });
});
