import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnnotationMark } from "../../../types/annotationReference";
import { bytesToDataUrl, composeReviewSvg, annotationContentHash, fnv1a64Hex } from "./export";

const layer = {
  markup: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
  width: 10,
  height: 10,
};

describe("review image", () => {
  it("embeds the figure and every mark, and escapes note text", () => {
    const svg = composeReviewSvg(layer, [
      { id: "t", kind: "text", color: "#000", points: [[1, 2]], text: 'a < b & "c"' },
      {
        id: "a",
        kind: "arrow",
        color: "#e03131",
        points: [
          [0, 0],
          [9, 9],
        ],
      },
    ]);

    expect(svg.startsWith("<svg xmlns=")).toBe(true);
    expect(svg).toContain('<rect width="10" height="10"/>');
    expect(svg).toContain("a &lt; b &amp; &quot;c&quot;");
    // 箭头 = 白垫底 + 彩色描边两条路径。
    expect(svg.match(/stroke="#e03131"/g)?.length).toBe(1);
    expect(svg.match(/stroke="#ffffff"/g)?.length).toBe(1);
  });

  it("keeps the font stack quote-free so the whole review image stays decodable", () => {
    const svg = composeReviewSvg(layer, [{ id: "t", kind: "text", color: "#000", points: [[1, 2]], text: "x" }]);
    expect(svg).toContain('font-family="system-ui, -apple-system, PingFang SC');
    expect(svg).not.toContain('font-family="system-ui, -apple-system, "');
  });

  it("embeds the figure verbatim so prefixed namespaces stay declared", () => {
    // 前缀声明长在根标签上：剥壳重包会留下未绑定的前缀，整张审阅图解码失败。
    const prefixed = {
      markup:
        '<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"' +
        ' width="10" height="10" viewBox="0 0 10 10"><g inkscape:label="sleeve"><rect width="10" height="10"/></g></svg>',
      width: 10,
      height: 10,
    };
    const svg = composeReviewSvg(prefixed, []);
    expect(svg).toContain('xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"');
    expect(svg).toContain('inkscape:label="sleeve"');
    expect(new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror")).toBeNull();
  });

  it("always paints a white background, including for an empty annotation", () => {
    const svg = composeReviewSvg(layer, []);
    expect(svg).toContain('<rect x="0" y="0" width="10" height="10" fill="#ffffff"/>');
  });

  it("encodes bytes as a data URL, across chunk boundaries", () => {
    expect(bytesToDataUrl(new Uint8Array([1, 2, 3]), "image/png")).toBe("data:image/png;base64,AQID");
    expect(bytesToDataUrl(new Uint8Array(0x8000 + 5).fill(7), "image/png").length).toBeGreaterThan(0x8000);
  });

  it("never embeds a mark's stroke colour as text content", () => {
    const marks: AnnotationMark[] = [
      {
        id: "p",
        kind: "pen",
        color: "#1971c2",
        points: [
          [0, 0],
          [1, 1],
        ],
        text: "#1971c2",
      },
    ];
    expect(composeReviewSvg(layer, marks)).toContain(">#1971c2</text>");
  });
});

describe("figure content hash", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("computes the documented FNV-1a 64 fingerprint", () => {
    // 参考向量取自 FNV 规范（offset basis 与标准测试串）。
    expect(fnv1a64Hex(new Uint8Array())).toBe("cbf29ce484222325");
    expect(fnv1a64Hex(new TextEncoder().encode("a"))).toBe("af63dc4c8601ec8c");
    expect(fnv1a64Hex(new TextEncoder().encode("foobar"))).toBe("85944171f73967e8");
    // 恒 16 位十六进制，且同输入同结果、异输入异结果。
    expect(fnv1a64Hex(new Uint8Array([0, 0, 0]))).toHaveLength(16);
    expect(fnv1a64Hex(new TextEncoder().encode("figure"))).toBe(fnv1a64Hex(new TextEncoder().encode("figure")));
    expect(fnv1a64Hex(new TextEncoder().encode("figure"))).not.toBe(fnv1a64Hex(new TextEncoder().encode("figurf")));
  });

  it("prefers Web Crypto SHA-256 when it is available", async () => {
    vi.stubGlobal("crypto", {
      subtle: { digest: async () => new Uint8Array(32).fill(0xab).buffer },
    });
    await expect(annotationContentHash(new Uint8Array([1, 2, 3]))).resolves.toEqual({
      algo: "sha256",
      hex: "ab".repeat(32),
    });
  });

  it("falls back to the JS fingerprint instead of failing without Web Crypto", async () => {
    // 非安全上下文（局域网 http）没有 `crypto.subtle`：取哈希不得抛错，否则整块面板不可用。
    vi.stubGlobal("crypto", {});
    await expect(annotationContentHash(new TextEncoder().encode("foobar"))).resolves.toEqual({
      algo: "fnv1a64",
      hex: "85944171f73967e8",
    });
  });
});
