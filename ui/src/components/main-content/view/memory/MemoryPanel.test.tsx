// @vitest-environment jsdom
/**
 * memory-dashboard iframe 的凭据判据（#626：文档 URL 用短期 dashboard 票据替代会话 JWT）。
 *
 * 不变式：iframe src 携 `?ticket=`、不含会话 JWT 的 `?token=`；缺项目路径时不申请票据。
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../../types/app";
import MemoryPanel from "./MemoryPanel";

const requestUrlTicketMock = vi.hoisted(() => vi.fn());

vi.mock("../../../../utils/api", () => ({
  requestUrlTicket: requestUrlTicketMock,
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ i18n: { language: "en" } }),
}));
vi.mock("../../../../contexts/ThemeContext", () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

beforeEach(() => {
  requestUrlTicketMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("MemoryPanel", () => {
  it("dashboard iframe 携 ?ticket=、不含会话 token，并申请 dashboard 用途票据", async () => {
    requestUrlTicketMock.mockResolvedValue("dash-ticket-value");
    const project = { name: "demo", path: "/root/demo", fullPath: "/root/demo" } as Project;

    render(<MemoryPanel selectedProject={project} />);

    const iframe = await screen.findByTitle("Memory Dashboard");
    const src = iframe.getAttribute("src") ?? "";
    expect(src).toContain("/memory-dashboard/index.html?");
    expect(src).toContain("ticket=dash-ticket-value");
    expect(src).not.toContain("token=");
    expect(requestUrlTicketMock).toHaveBeenCalledWith("dashboard");
  });

  it("缺项目路径时不申请票据，展示不可用", () => {
    requestUrlTicketMock.mockResolvedValue("dash-ticket-value");
    const project = { name: "demo" } as Project;

    render(<MemoryPanel selectedProject={project} />);

    expect(screen.getByText("Memory dashboard is unavailable until auth and project context are ready.")).toBeTruthy();
    expect(requestUrlTicketMock).not.toHaveBeenCalled();
  });

  it("无选中项目时提示选择项目", () => {
    render(<MemoryPanel selectedProject={null} />);
    expect(screen.getByText("Select a project to inspect memory.")).toBeTruthy();
    expect(requestUrlTicketMock).not.toHaveBeenCalled();
  });
});
