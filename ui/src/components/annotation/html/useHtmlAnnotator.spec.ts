/**
 * H3 纯函数：标注 URL 组装与 nonce 生成（消息路由与命中换算由 snapshot.spec 覆盖）。
 */
import { describe, expect, it } from "vitest";
import { buildAnnotateUrl, createHtmlAnnotationNonce } from "./useHtmlAnnotator";

describe("buildAnnotateUrl", () => {
  it("appends annotate parameters to a plain preview URL", () => {
    expect(buildAnnotateUrl("/api/projects/p/preview/index.html", "n1")).toBe(
      "/api/projects/p/preview/index.html?annotate=1&sati_nonce=n1",
    );
  });

  it("keeps the existing query (the preview credential lives there)", () => {
    expect(buildAnnotateUrl("/api/projects/p/preview/index.html?token=abc", "n1")).toBe(
      "/api/projects/p/preview/index.html?token=abc&annotate=1&sati_nonce=n1",
    );
  });
});

describe("createHtmlAnnotationNonce", () => {
  it("produces a 24-char hex nonce accepted by the server-side pattern", () => {
    const nonce = createHtmlAnnotationNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(createHtmlAnnotationNonce()).not.toBe(nonce);
  });
});
