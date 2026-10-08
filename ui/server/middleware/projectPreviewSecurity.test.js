// @vitest-environment node
/**
 * 项目预览与项目文件响应安全头的判据（P0 第二道防线）。
 *
 * 不变式：
 * - 预览文档与可渲染的项目文件（HTML/SVG/XML）始终是不透明源（sandbox 不含 allow-same-origin），
 *   即使被同源顶层导航到，也无法以应用身份执行；
 * - 外发通道被 connect-src 关闭；
 * - 外部主机只来自显式白名单；sibling 资源（'self'）可加载；
 * - 图片、PDF 等非文档类型不加沙箱头，避免影响渲染。
 */
import { describe, expect, it } from "vitest";
import {
  applyProjectFileSecurityHeaders,
  applyProjectPreviewSecurityHeaders,
  isActiveDocumentMimeType,
  PROJECT_PREVIEW_CSP,
  PROJECT_PREVIEW_EXTERNAL_HOSTS,
  shouldForceAttachment,
} from "./projectPreviewSecurity.js";

function fakeResponse() {
  const headers = {};
  return {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
}

function directive(csp, name) {
  return csp
    .split(";")
    .map(part => part.trim())
    .find(part => part.startsWith(`${name} `) || part === name);
}

describe("项目预览安全头", () => {
  it("同时设置 CSP、nosniff 与 no-referrer", () => {
    const res = fakeResponse();
    applyProjectPreviewSecurityHeaders(res);
    expect(res.headers["Content-Security-Policy"]).toBe(PROJECT_PREVIEW_CSP);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(res.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("sandbox 指令存在且不含 allow-same-origin（文档保持不透明源，顶层打开也读不到应用源存储）", () => {
    const sandbox = directive(PROJECT_PREVIEW_CSP, "sandbox");
    expect(sandbox).toBeDefined();
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("connect-src 关闭，脚本无法向任意地址外发数据", () => {
    expect(directive(PROJECT_PREVIEW_CSP, "connect-src")).toBe("connect-src 'none'");
  });

  it("default-src 为 none，且不放行通配符来源", () => {
    expect(directive(PROJECT_PREVIEW_CSP, "default-src")).toBe("default-src 'none'");
    expect(PROJECT_PREVIEW_CSP).not.toMatch(/\*/);
  });

  it("脚本、样式、字体允许同源（sibling 资源）与白名单外部主机", () => {
    expect(directive(PROJECT_PREVIEW_CSP, "script-src")).toBe(
      `script-src 'self' 'unsafe-inline' ${PROJECT_PREVIEW_EXTERNAL_HOSTS.scripts.join(" ")}`,
    );
    expect(directive(PROJECT_PREVIEW_CSP, "style-src")).toBe(
      `style-src 'self' 'unsafe-inline' ${PROJECT_PREVIEW_EXTERNAL_HOSTS.styles.join(" ")}`,
    );
    expect(directive(PROJECT_PREVIEW_CSP, "font-src")).toBe(
      `font-src 'self' data: ${PROJECT_PREVIEW_EXTERNAL_HOSTS.fonts.join(" ")}`,
    );
  });

  it("图片不允许任意外部来源（防止经图片 URL 外发）", () => {
    expect(directive(PROJECT_PREVIEW_CSP, "img-src")).toBe("img-src 'self' data: blob:");
  });
});

describe("可渲染文档的 MIME 判定", () => {
  it.each([
    "text/html",
    "text/html; charset=utf-8",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/xml",
    "application/xml",
  ])("%s 是脚本文档类型", mimeType => {
    expect(isActiveDocumentMimeType(mimeType)).toBe(true);
  });

  it.each([
    "image/png",
    "application/pdf",
    "text/plain",
    "application/octet-stream",
    "text/css",
    "application/javascript",
  ])("%s 不是脚本文档类型", mimeType => {
    expect(isActiveDocumentMimeType(mimeType)).toBe(false);
  });

  it("空值与非字符串不当作文档", () => {
    expect(isActiveDocumentMimeType(undefined)).toBe(false);
    expect(isActiveDocumentMimeType(null)).toBe(false);
  });
});

describe("强制下载的 MIME 判定（.mht/.mhtml）", () => {
  it("message/rfc822（MHTML）强制下载，不以文档渲染", () => {
    expect(shouldForceAttachment("message/rfc822")).toBe(true);
    expect(shouldForceAttachment("message/rfc822; charset=utf-8")).toBe(true);
  });

  it("常见类型不强制下载", () => {
    expect(shouldForceAttachment("text/html")).toBe(false);
    expect(shouldForceAttachment("image/png")).toBe(false);
    expect(shouldForceAttachment(undefined)).toBe(false);
  });
});

describe("项目原始文件的响应安全头（files/content）", () => {
  it("HTML 文件带沙箱 CSP（同源顶层导航也不会以应用源运行）", () => {
    const res = fakeResponse();
    applyProjectFileSecurityHeaders(res, "text/html");
    expect(res.headers["Content-Security-Policy"]).toBe(PROJECT_PREVIEW_CSP);
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("SVG 文件同样带沙箱 CSP（SVG 文档可执行脚本）", () => {
    const res = fakeResponse();
    applyProjectFileSecurityHeaders(res, "image/svg+xml");
    expect(res.headers["Content-Security-Policy"]).toBe(PROJECT_PREVIEW_CSP);
  });

  it("图片文件只加 nosniff，不加沙箱 CSP（不影响 <img> 渲染）", () => {
    const res = fakeResponse();
    applyProjectFileSecurityHeaders(res, "image/png");
    expect(res.headers["Content-Security-Policy"]).toBeUndefined();
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  it("PDF 文件只加 nosniff，不加沙箱 CSP（不影响 pdf.js 渲染）", () => {
    const res = fakeResponse();
    applyProjectFileSecurityHeaders(res, "application/pdf");
    expect(res.headers["Content-Security-Policy"]).toBeUndefined();
    expect(res.headers["X-Content-Type-Options"]).toBe("nosniff");
  });
});
