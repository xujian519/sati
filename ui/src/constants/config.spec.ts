/**
 * HTML 标注发布门控（D6）的默认值与开关行为。
 *
 * 门控默认关闭：旧版读者读到未知 kind 会视为「从未标注」并在保存时静默覆盖，
 * 因此只有显式开启后才允许写入 `kind:"html"`（见 docs/html-annotation-plan.md §4.6）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHtmlAnnotationKindWriteEnabled } from "./config";

describe("HTML annotation write gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is closed by default", () => {
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(false);
  });

  it("opens only when VITE_ENABLE_HTML_ANNOTATION is exactly true", () => {
    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "1");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(false);

    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "true");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(true);
  });
});
