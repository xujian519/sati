/**
 * 项目预览 URL 的凭据判据（P0：会话 JWT 不得进入预览 URL）。
 *
 * 不变式：预览 URL 只携带仅限预览路由的短期凭据；会话 token 留在 Authorization 头中，
 * 永远不出现在可被文档脚本读取的 location 里。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

const SESSION_TOKEN = "session-jwt-must-not-leak";
const PREVIEW_TOKEN = "preview-scoped-token";

describe("api.projectPreviewUrl", () => {
  beforeEach(() => {
    localStorage.setItem("auth-token", SESSION_TOKEN);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: async () => ({ token: PREVIEW_TOKEN, expiresIn: 900 }),
      })),
    );
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("预览 URL 携带预览凭据，且不含会话 token", async () => {
    const url = await api.projectPreviewUrl("demo", "reports/index.html", "/root/demo");

    expect(url).toContain(`token=${PREVIEW_TOKEN}`);
    expect(url).not.toContain(SESSION_TOKEN);
    expect(url.startsWith("/api/projects/demo/preview/reports/index.html?")).toBe(true);
  });

  it("预览凭据通过项目专属端点申请，会话 token 只出现在 Authorization 头里", async () => {
    await api.projectPreviewUrl("demo", "index.html", "/root/demo");

    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe("/api/projects/demo/preview-token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it("申请凭据失败时抛错，不回退到携带会话 token 的 URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, headers: new Headers(), json: async () => ({}) })),
    );

    await expect(api.projectPreviewUrl("demo", "index.html", "/root/demo")).rejects.toThrow(/403/);
  });
});
