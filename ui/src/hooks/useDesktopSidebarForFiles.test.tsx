import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AppTab } from "../types/app";
import { useDesktopSidebarForFiles } from "./useDesktopSidebarForFiles";

type HookProps = { activeTab: AppTab; mobile: boolean };

const renderSidebar = (initialTab: AppTab = "chat", isMobile = false) =>
  renderHook(({ activeTab, mobile }: HookProps) => useDesktopSidebarForFiles({ activeTab, isMobile: mobile }), {
    initialProps: { activeTab: initialTab, mobile: isMobile },
  });

describe("useDesktopSidebarForFiles", () => {
  it("collapses the sidebar when entering the files tab and restores it on leaving", () => {
    const { result, rerender } = renderSidebar();

    expect(result.current.desktopSidebarOpen).toBe(true);

    act(() => rerender({ activeTab: "files", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => rerender({ activeTab: "chat", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(true);
  });

  it("collapses on mount when the app loads directly into the files tab", () => {
    const { result, rerender } = renderSidebar("files");

    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => rerender({ activeTab: "chat", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(true);
  });

  it("restores a collapsed sidebar when it was already collapsed before entering files", () => {
    const { result, rerender } = renderSidebar();

    act(() => result.current.collapseDesktopSidebar());
    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => rerender({ activeTab: "files", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => rerender({ activeTab: "chat", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(false);
  });

  it("keeps a manual toggle made inside the files view when leaving", () => {
    const { result, rerender } = renderSidebar();

    act(() => rerender({ activeTab: "files", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => result.current.openDesktopSidebar());
    expect(result.current.desktopSidebarOpen).toBe(true);

    act(() => rerender({ activeTab: "chat", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(true);
  });

  it("restores when leaving files for any other tab, including kanban", () => {
    const { result, rerender } = renderSidebar();

    act(() => rerender({ activeTab: "files", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(false);

    act(() => rerender({ activeTab: "kanban", mobile: false }));
    expect(result.current.desktopSidebarOpen).toBe(true);
  });

  it("leaves the sidebar state untouched on mobile", () => {
    const { result, rerender } = renderSidebar("chat", true);

    act(() => rerender({ activeTab: "files", mobile: true }));
    expect(result.current.desktopSidebarOpen).toBe(true);

    act(() => rerender({ activeTab: "chat", mobile: true }));
    expect(result.current.desktopSidebarOpen).toBe(true);
  });
});
