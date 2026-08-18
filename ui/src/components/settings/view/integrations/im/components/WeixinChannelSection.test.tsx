import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WeixinChannelSection from "./WeixinChannelSection";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("../../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
  // 无 token 时原样返回 URL（与真实实现一致）
  appendAuthToken: (url: string) => url,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("WeixinChannelSection", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts a fresh QR session before polling for its result", async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({ ok: false, error: "QR session unavailable" }),
    });

    render(
      <WeixinChannelSection
        status={{
          enabled: false,
          hasCredentials: false,
          accountId: null,
        }}
        onSaved={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "gateway.weixin.qrLogin" }));

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith("/api/gateway/weixin/qr-begin", { method: "POST" });
    });
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => url === "/api/gateway/weixin/qr")).toBe(false);
  });

  it("resumes an in-flight QR session from gateway runtime state", async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({
        pending: true,
        qrUrl: "https://example.test/existing-qr",
        runtime: {
          state: "waiting_for_login",
          qrUrl: "https://example.test/existing-qr",
          updatedAt: "2026-07-23T05:00:00.000Z",
        },
      }),
    });

    render(
      <WeixinChannelSection
        status={{
          enabled: true,
          hasCredentials: false,
          accountId: null,
          runtime: {
            state: "waiting_for_login",
            qrUrl: "https://example.test/existing-qr",
            updatedAt: "2026-07-23T05:00:00.000Z",
          },
        }}
        onSaved={vi.fn(async () => null)}
      />,
    );

    await waitFor(() => {
      const src = screen.getByAltText("WeChat QR Code").getAttribute("src") ?? "";
      expect(src).toContain("existing-qr");
      // 二维码必须走本地端点，不得依赖境外 api.qrserver.com（教育网不可达）
      expect(src).toContain("/api/gateway/qr-image");
      expect(src).not.toContain("qrserver.com");
    });
    expect(screen.getAllByText("gateway.weixin.waitingForLogin")).toHaveLength(2);
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => url === "/api/gateway/weixin/qr-begin")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "gateway.cancel" }));
    expect(screen.queryByAltText("WeChat QR Code")).toBeNull();
    expect(screen.getByRole("button", { name: "gateway.weixin.relogin" })).toBeTruthy();
  });

  it("ignores a terminal runtime result left over from an older QR request", async () => {
    vi.useFakeTimers();
    mocks.authenticatedFetch
      .mockResolvedValueOnce({
        json: async () => ({
          ok: true,
          requestedAt: "2026-07-23T05:00:00.000Z",
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          ok: false,
          error: "stale failure",
          runtime: { updatedAt: "2026-07-22T05:00:00.000Z" },
        }),
      })
      .mockResolvedValueOnce({
        json: async () => ({
          pending: true,
          qrUrl: "https://example.test/fresh-qr",
          runtime: { updatedAt: "2026-07-23T05:00:01.000Z" },
        }),
      });

    render(
      <WeixinChannelSection
        status={{
          enabled: false,
          hasCredentials: false,
          accountId: null,
        }}
        onSaved={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "gateway.weixin.qrLogin" }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.queryByText("stale failure")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.getByAltText("WeChat QR Code").getAttribute("src")).toContain("fresh-qr");
  });

  it("auto-shows the self-healed QR after an expired session without clicking", async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      json: async () => ({
        pending: true,
        qrUrl: "https://example.test/healed-qr",
        runtime: {
          state: "waiting_for_login",
          qrUrl: "https://example.test/healed-qr",
          updatedAt: "2026-07-23T06:00:00.000Z",
        },
      }),
    });

    const { rerender } = render(
      <WeixinChannelSection
        status={{
          enabled: true,
          hasCredentials: false,
          accountId: null,
          runtime: {
            state: "expired",
            updatedAt: "2026-07-23T05:59:59.000Z",
            message: "微信登录已过期，请重新扫码登录",
          },
        }}
        onSaved={vi.fn()}
      />,
    );

    // 初始 expired：展示过期提示，不展示二维码
    expect(screen.queryByAltText("WeChat QR Code")).toBeNull();
    expect(screen.getAllByText("gateway.weixin.expired").length).toBeGreaterThan(0);

    // 通道自愈后（waiting_for_login + qrUrl）：无需点击，二维码自动出现
    rerender(
      <WeixinChannelSection
        status={{
          enabled: true,
          hasCredentials: false,
          accountId: null,
          runtime: {
            state: "waiting_for_login",
            qrUrl: "https://example.test/healed-qr",
            updatedAt: "2026-07-23T06:00:00.000Z",
          },
        }}
        onSaved={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByAltText("WeChat QR Code").getAttribute("src")).toContain("healed-qr");
    });
    // 自愈路径不发起新的扫码会话（不调 qr-begin）
    expect(mocks.authenticatedFetch.mock.calls.some(([url]) => url === "/api/gateway/weixin/qr-begin")).toBe(false);
  });
});
