/**
 * `referenceSurfaceOf` 的面映射：标注面的 kind 与引用载荷的 `locator.surface` 必须一一对应。
 */
import { describe, expect, it } from "vitest";
import { referenceSurfaceOf } from "./types";

describe("referenceSurfaceOf", () => {
  it("maps every target kind to its locator surface", () => {
    expect(referenceSurfaceOf("figure-svg")).toBe("figure");
    expect(referenceSurfaceOf("image")).toBe("image");
    expect(referenceSurfaceOf("html")).toBe("html");
  });
});
