import { describe, expect, it } from "vitest";
import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  getRotatedPageSize,
  isQuarterTurn,
  parsePageInput,
  parsePercentInput,
  resolveActiveScale,
} from "./pdfViewport";

describe("clamp", () => {
  it("夹在区间内，含边界", () => {
    expect(clamp(5, 1, 3)).toBe(3);
    expect(clamp(0, 1, 3)).toBe(1);
    expect(clamp(2, 1, 3)).toBe(2);
  });
});

describe("isQuarterTurn / getRotatedPageSize", () => {
  it("只有 90° 与 270° 是横向四分之一转", () => {
    expect(isQuarterTurn(0)).toBe(false);
    expect(isQuarterTurn(90)).toBe(true);
    expect(isQuarterTurn(180)).toBe(false);
    expect(isQuarterTurn(270)).toBe(true);
  });

  it("四分之一转才交换宽高，其余原样返回", () => {
    const size = { width: 600, height: 800 };
    expect(getRotatedPageSize(size, 0)).toEqual({ width: 600, height: 800 });
    expect(getRotatedPageSize(size, 180)).toEqual({ width: 600, height: 800 });
    expect(getRotatedPageSize(size, 90)).toEqual({ width: 800, height: 600 });
    expect(getRotatedPageSize(size, 270)).toEqual({ width: 800, height: 600 });
  });
});

describe("resolveActiveScale", () => {
  const fitScales = { fitWidth: 1.4, fitPage: 1.1 };

  it("fitWidth / fitPage 取拟合比例，custom 取自定义比例", () => {
    expect(resolveActiveScale("fitWidth", fitScales, 2)).toBe(1.4);
    expect(resolveActiveScale("fitPage", fitScales, 2)).toBe(1.1);
    expect(resolveActiveScale("custom", fitScales, 2)).toBe(2);
  });
});

describe("parsePercentInput", () => {
  it("接受带或不带 % 的百分比", () => {
    expect(parsePercentInput("150%")).toBeCloseTo(1.5);
    expect(parsePercentInput(" 150 % ")).toBeCloseTo(1.5);
  });

  it("空串与非数字 → null", () => {
    expect(parsePercentInput("")).toBeNull();
    expect(parsePercentInput("   ")).toBeNull();
    expect(parsePercentInput("abc")).toBeNull();
    expect(parsePercentInput("%")).toBeNull();
  });

  it("按 MIN_SCALE/MAX_SCALE 夹取", () => {
    expect(parsePercentInput("1000%")).toBe(MAX_SCALE);
    expect(parsePercentInput("1%")).toBe(MIN_SCALE);
    expect(parsePercentInput(`${MAX_SCALE * 100}%`)).toBe(MAX_SCALE);
  });
});

describe("parsePageInput", () => {
  it("解析页码并按 [1, totalPages] 夹取", () => {
    expect(parsePageInput("3", 10)).toBe(3);
    expect(parsePageInput("  3  ", 10)).toBe(3);
    expect(parsePageInput("99", 10)).toBe(10);
    expect(parsePageInput("0", 10)).toBe(1);
    expect(parsePageInput("-4", 10)).toBe(1);
  });

  it("非数字 → null（调用方据此回退显示当前页）", () => {
    expect(parsePageInput("", 10)).toBeNull();
    expect(parsePageInput("abc", 10)).toBeNull();
  });

  it("总页数为 0/未知时下限仍是 1", () => {
    expect(parsePageInput("5", 0)).toBe(1);
  });
});
