/**
 * URL 票据化的前端 builder 判据（#626：会话 JWT 不再进入无头载体的 URL）。
 *
 * 不变式：
 * - `*Url` 系列（供 `<iframe>`/`<img>`/`<a download>`/EventSource）先向 `/api/url-ticket` 换一份短期
 *   票据，URL 只带 `?ticket=`，绝不含 localStorage 里的会话 JWT；
 * - 头部可用的消费者（readFileBlob / preflight*）请求不带任何凭据的裸端点，凭据只在 Authorization 头；
 * - 旧的 `appendAuthToken`（把会话 JWT 拼进 query）已从模块移除。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import * as apiModule from "./api";

const SESSION_TOKEN = "session-jwt-must-not-leak";
const TICKET = "url-ticket-value";

function stubTicketFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ token: TICKET, expiresIn: 300 }),
    })),
  );
}

describe("api URL 票据 builders", () => {
  beforeEach(() => {
    localStorage.setItem("auth-token", SESSION_TOKEN);
    stubTicketFetch();
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it("appendAuthToken 已移除（不再把会话 JWT 拼进 query）", () => {
    expect((apiModule as Record<string, unknown>).appendAuthToken).toBeUndefined();
  });

  it("fileContentUrl 携 ?ticket=、不含会话 token，并向 /api/url-ticket 申请 purpose=file", async () => {
    const url = await api.fileContentUrl("demo", "a/b.txt");

    expect(url).toContain("/api/projects/demo/files/content");
    expect(url).toContain("path=a%2Fb.txt");
    expect(url).toContain(`ticket=${TICKET}`);
    expect(url).not.toContain(SESSION_TOKEN);

    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toBe("/api/url-ticket");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ purpose: "file", project: "demo", path: "a/b.txt" });
  });

  it("fileDownloadUrl（异步）携下载与 ?ticket=、不含会话 token", async () => {
    const url = await api.fileDownloadUrl("demo", "report.pdf");

    expect(url).toContain("download=1");
    expect(url).toContain(`ticket=${TICKET}`);
    expect(url).not.toContain(SESSION_TOKEN);
  });

  it("officePdfPreviewUrl 携 ?ticket=、不含会话 token", async () => {
    const url = await api.officePdfPreviewUrl("demo", "deck.pptx");

    expect(url).toContain("/api/projects/demo/files/preview/pdf");
    expect(url).toContain(`ticket=${TICKET}`);
    expect(url).not.toContain(SESSION_TOKEN);
  });

  it("spreadsheetSheetPreviewUrl 携 ?ticket=、绑定项目与路径", async () => {
    const url = await api.spreadsheetSheetPreviewUrl("demo", "book.xlsx", 2);

    expect(url).toContain("/api/projects/demo/files/preview/spreadsheet/sheet");
    expect(url).toContain("sheet=2");
    expect(url).toContain(`ticket=${TICKET}`);
    expect(url).not.toContain(SESSION_TOKEN);

    const body = JSON.parse(String((vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toMatchObject({ purpose: "file", project: "demo", path: "book.xlsx" });
  });

  it("申请票据失败时抛错，绝不回退到携带会话 token 的 URL", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 403, headers: new Headers(), json: async () => ({}) })),
    );

    await expect(api.fileContentUrl("demo", "a/b.txt")).rejects.toThrow(/403/);
  });

  it("readFileBlob 请求裸端点：无 ?ticket=、无会话 token，凭据只在 Authorization 头", async () => {
    await api.readFileBlob("demo", "a/b.txt");

    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toContain("/api/projects/demo/files/content");
    expect(requestUrl).not.toContain("ticket=");
    expect(requestUrl).not.toContain(SESSION_TOKEN);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });

  it("preflightOfficePdfPreview 请求裸端点，URL 不含任何凭据", async () => {
    await api.preflightOfficePdfPreview("demo", "deck.pptx", {});

    const [requestUrl, init] = vi.mocked(fetch).mock.calls[0] as unknown as [string, RequestInit];
    expect(requestUrl).toContain("/files/preview/pdf");
    expect(requestUrl).not.toContain("ticket=");
    expect(requestUrl).not.toContain("token=");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${SESSION_TOKEN}`);
  });
});
