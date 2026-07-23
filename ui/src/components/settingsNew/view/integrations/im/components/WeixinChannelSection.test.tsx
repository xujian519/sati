import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WeixinChannelSection from "./WeixinChannelSection";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock("../../../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
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

    fireEvent.click(
      screen.getByRole("button", { name: "gateway.weixin.qrLogin" }),
    );

    await waitFor(() => {
      expect(mocks.authenticatedFetch).toHaveBeenCalledWith(
        "/api/gateway/weixin/qr-begin",
        { method: "POST" },
      );
    });
    expect(
      mocks.authenticatedFetch.mock.calls.some(
        ([url]) => url === "/api/gateway/weixin/qr",
      ),
    ).toBe(false);
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
      fireEvent.click(
        screen.getByRole("button", { name: "gateway.weixin.qrLogin" }),
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(screen.queryByText("stale failure")).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(
      screen.getByAltText("WeChat QR Code").getAttribute("src"),
    ).toContain("fresh-qr");
  });
});
