/**
 * HTML 标注发布门控（D6）的默认值与开关行为。
 *
 * 门控自 2026-10-23 起默认开启（#624）；仅显式 `false`/`0` 关闭，供仍有多版本
 * Sati 共存、旧读者可能静默覆盖侧车的环境使用（见
 * docs/notes/implemented/2026-10-23-html-annotation-gate-opened.md）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { isHtmlAnnotationKindWriteEnabled } from "./config";

describe("HTML annotation write gate", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is open by default", () => {
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(true);
  });

  it("stays open unless explicitly disabled", () => {
    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "true");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(true);

    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "1");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(true);
  });

  it("closes when explicitly disabled", () => {
    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "false");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(false);

    vi.stubEnv("VITE_ENABLE_HTML_ANNOTATION", "0");
    expect(isHtmlAnnotationKindWriteEnabled()).toBe(false);
  });
});
