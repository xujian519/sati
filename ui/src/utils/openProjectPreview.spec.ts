/**
 * 新标签页打开项目预览的判据：保住用户手势、断开 opener、失败时关闭空白窗口。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { openProjectPreviewInNewTab } from "./openProjectPreview";

type FakeWindow = { opener: unknown; location: { href: string }; close: ReturnType<typeof vi.fn> };

function fakeWindow(): FakeWindow {
  return { opener: "app", location: { href: "about:blank" }, close: vi.fn() };
}

describe("openProjectPreviewInNewTab", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("同步先开 about:blank 窗口（保住用户手势），且不带 noopener（否则拿不到窗口句柄）", () => {
    const win = fakeWindow();
    const openSpy = vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    vi.spyOn(api, "projectPreviewUrl").mockResolvedValue("/api/projects/p/preview/index.html?token=t");

    openProjectPreviewInNewTab("p", "index.html", "/root/p");

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy).toHaveBeenCalledWith("about:blank", "_blank");
  });

  it("取到预览地址后导航，并断开 opener", async () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    vi.spyOn(api, "projectPreviewUrl").mockResolvedValue("/api/projects/p/preview/index.html?token=t");

    openProjectPreviewInNewTab("p", "index.html", "/root/p");
    await vi.waitFor(() => expect(win.location.href).toBe("/api/projects/p/preview/index.html?token=t"));

    expect(win.opener).toBeNull();
    expect(win.close).not.toHaveBeenCalled();
  });

  it("申请凭据失败时关闭空白窗口，不导航", async () => {
    const win = fakeWindow();
    vi.spyOn(window, "open").mockReturnValue(win as unknown as Window);
    vi.spyOn(api, "projectPreviewUrl").mockRejectedValue(new Error("Failed to create preview token (403)"));

    openProjectPreviewInNewTab("p", "index.html", "/root/p");
    await vi.waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));

    expect(win.location.href).toBe("about:blank");
  });

  it("弹窗被拦截（window.open 返回 null）时不申请凭据", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const urlSpy = vi.spyOn(api, "projectPreviewUrl");

    openProjectPreviewInNewTab("p", "index.html", "/root/p");

    expect(urlSpy).not.toHaveBeenCalled();
  });
});
