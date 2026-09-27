import { describe, expect, it } from "vitest";
import { isContentReference } from "../../../types/contentReference";
import { buildRegionReference } from "./regionReference";

const base = {
  projectName: "demo",
  relativePath: "/w/project/figures/inv-fig1.svg",
  fileName: "inv-fig1.svg",
  mimeType: "image/svg+xml",
  fileSize: 1234,
  surface: "figure" as const,
};

describe("image region reference", () => {
  it("builds a region reference that validates, anchored on the figure surface", () => {
    const reference = buildRegionReference({
      ...base,
      capture: {
        rect: { x: 0.25, y: 0.2, width: 0.5, height: 0.3 },
        dataUrl: "data:image/png;base64,AAAA",
        width: 120,
        height: 90,
      },
    });

    expect(reference.selectionMode).toBe("region");
    expect(reference.locator.surface).toBe("figure");
    expect(reference.image).toMatchObject({ mimeType: "image/png", width: 120, height: 90 });
    expect(reference.image.name.startsWith(`reference-${base.fileName}-`)).toBe(true);
    expect(reference.source.revision).toEqual({ size: 1234 });
    expect(isContentReference(reference)).toBe(true);
  });

  it("clamps a region that runs outside the figure", () => {
    const reference = buildRegionReference({
      ...base,
      capture: {
        rect: { x: -1, y: 0.8, width: 3, height: 3 },
        dataUrl: "data:image/png;base64,AAAA",
        width: 10,
        height: 10,
      },
    });

    // 越界的起点被钳到 0，越界的尺寸被裁到图面边界内（浮点用近似比较）。
    const rect = reference.locator.rect;
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0.8);
    expect(rect.width).toBe(1);
    expect(rect.height).toBeCloseTo(0.2);
  });

  it("omits the revision and the project name when they are unknown", () => {
    const reference = buildRegionReference({
      projectName: undefined,
      relativePath: "a.svg",
      fileName: "a.svg",
      mimeType: "image/svg+xml",
      fileSize: undefined,
      surface: "figure",
      capture: {
        rect: { x: 0, y: 0, width: 1, height: 1 },
        dataUrl: "data:image/png;base64,AAAA",
        width: 1,
        height: 1,
      },
    });

    expect(reference.source.revision).toBeUndefined();
    expect(reference.source.projectName).toBeUndefined();
    expect(isContentReference(reference)).toBe(true);
  });

  it("anchors a raster region on the image surface, not on a figure", () => {
    const reference = buildRegionReference({
      ...base,
      relativePath: "/w/project/scans/page-1.png",
      fileName: "page-1.png",
      mimeType: "image/png",
      surface: "image",
      capture: {
        rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        dataUrl: "data:image/png;base64,AAAA",
        width: 20,
        height: 20,
      },
    });

    expect(reference.locator.surface).toBe("image");
    expect(isContentReference(reference)).toBe(true);
  });
});
