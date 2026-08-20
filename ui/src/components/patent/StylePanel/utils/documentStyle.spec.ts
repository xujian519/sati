import { describe, expect, it } from "vitest";
import { buildStyleOverridesCss, flattenDocumentStyle, injectStyleCssIntoHtml } from "./documentStyle";

const SAMPLE_STYLE = {
  fontSize: { base: "14pt", x2l: "20pt" },
  leading: { body: "1.8" },
  page: { margin: "20mm 25mm 20mm 25mm" },
  color: { accent: "#123456" },
  brand: { firm: '测试所 "A"' },
} as const;

describe("flattenDocumentStyle", () => {
  it("按分组展开为扁平键并丢弃空值", () => {
    const flat = flattenDocumentStyle(SAMPLE_STYLE);
    expect(flat).toEqual({
      textBase: "14pt",
      text2xl: "20pt",
      leadingBody: "1.8",
      pageMargin: "20mm 25mm 20mm 25mm",
      accent: "#123456",
      firm: '测试所 "A"',
    });
  });

  it("空对象返回空映射", () => {
    expect(flattenDocumentStyle({})).toEqual({});
  });
});

describe("buildStyleOverridesCss", () => {
  it("生成 :root 覆盖，文案类加引号、其他保留原值", () => {
    const css = buildStyleOverridesCss(SAMPLE_STYLE);
    expect(css).toContain(":root {");
    expect(css).toContain("--sati-doc-text-base: 14pt;");
    expect(css).toContain("--sati-doc-leading-body: 1.8;");
    expect(css).toContain("--sati-doc-accent: #123456;");
    expect(css).toContain('--sati-doc-firm: "测试所 \\"A\\"";');
  });

  it("空 style 产出空串（不注入无效样式）", () => {
    expect(buildStyleOverridesCss({})).toBe("");
  });
});

describe("injectStyleCssIntoHtml", () => {
  it("注入到 <head> 内、模板 <style> 之前", () => {
    const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{}</style></head><body></body></html>';
    const out = injectStyleCssIntoHtml(html, ":root { --sati-doc-text-base: 14pt; }");
    const headStart = out.indexOf("<head>");
    const injectedStyleAt = out.indexOf("<style>\n:root", headStart);
    const templateStyleAt = out.indexOf("<style>body", headStart);
    expect(injectedStyleAt).toBeGreaterThan(headStart);
    expect(injectedStyleAt).toBeLessThan(templateStyleAt);
  });

  it("无 <head> 时前置注入", () => {
    const out = injectStyleCssIntoHtml("<body>x</body>", ":root { --a: 1; }");
    expect(out.startsWith("<style>\n:root { --a: 1; }\n</style>")).toBe(true);
  });
});
