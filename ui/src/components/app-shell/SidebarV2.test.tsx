// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types/app";
import SidebarV2 from "./SidebarV2";

const general: Project = {
  name: "general",
  displayName: "general",
  fullPath: "/workspace/general",
  sessions: [],
};

const project: Project = {
  name: "sati",
  displayName: "Sati",
  fullPath: "/workspace/Sati",
  sessions: [],
};

function renderSidebar(selectedProject: Project | null, onCollapse?: () => void, onOpenTeamPanel?: () => void) {
  const props: ComponentProps<typeof SidebarV2> = {
    projects: [general, project],
    selectedProject,
    selectedSession: null,
    activeTab: "chat",
    isLoading: false,
    onSelectProject: vi.fn(),
    onSelectSession: vi.fn(),
    onStartNewSession: vi.fn(),
    onCreateProject: vi.fn(),
    onRequestDeleteProject: vi.fn(),
    onRequestDeleteSession: vi.fn(),
    onShowSettings: vi.fn(),
    onOpenTeamPanel,
    onCollapse,
  };

  const utils = render(
    <MemoryRouter>
      <SidebarV2 {...props} />
    </MemoryRouter>,
  );
  return { ...utils, props };
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SidebarV2 default section", () => {
  it("starts on Projects even when an old General preference remains in storage", () => {
    localStorage.setItem("sidebar-v2-active-section", "general");
    renderSidebar(null);

    expect(screen.getByRole("tab", { name: "Projects" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("false");
  });

  it("still shows General when an explicit General project is selected", async () => {
    renderSidebar(general);

    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "General" }).getAttribute("aria-selected")).toBe("true");
    });
  });
});

describe("SidebarV2 project click behavior", () => {
  // The project row button is the one containing the "Sati" text label;
  // the header logo button shares the same accessible name ("Sati" via
  // aria-label), so resolve by text and walk up to the row button.
  const clickProjectRow = () => {
    const label = screen.getByText("Sati");
    const row = label.closest("button");
    expect(row).not.toBeNull();
    fireEvent.click(row as HTMLButtonElement);
  };

  it("switches to an unselected project when its row is clicked", () => {
    const { props } = renderSidebar(null);

    clickProjectRow();

    expect(props.onSelectProject).toHaveBeenCalledTimes(1);
    expect(props.onSelectProject).toHaveBeenCalledWith(project);
  });

  it("keeps collapse/expand toggle when clicking the already-selected project", () => {
    const { props } = renderSidebar(project);

    clickProjectRow();

    expect(props.onSelectProject).not.toHaveBeenCalled();
  });
});

describe("SidebarV2 collapse button", () => {
  it("hides the collapse button when no onCollapse handler is provided", () => {
    renderSidebar(null);

    expect(screen.queryByRole("button", { name: "Hide sidebar" })).toBeNull();
  });

  it("renders the collapse button and fires onCollapse on click", () => {
    const onCollapse = vi.fn();
    renderSidebar(null, onCollapse);

    const button = screen.getByRole("button", { name: "Hide sidebar" });
    fireEvent.click(button);

    expect(onCollapse).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarV2 team panel entry", () => {
  it("hides the team button when no onOpenTeamPanel handler is provided", () => {
    renderSidebar(null);

    expect(screen.queryByRole("button", { name: "Team" })).toBeNull();
  });

  it("renders the team button and fires onOpenTeamPanel on click", () => {
    const onOpenTeamPanel = vi.fn();
    renderSidebar(null, undefined, onOpenTeamPanel);

    const button = screen.getByRole("button", { name: "Team" });
    fireEvent.click(button);

    expect(onOpenTeamPanel).toHaveBeenCalledTimes(1);
  });
});

describe("SidebarV2 resize handle", () => {
  /** 拖拽期间的全屏遮罩（`fixed inset-0 z-[60]`）——它盖住分隔条，双击事件到不了。 */
  const dragOverlay = () => document.querySelector(".z-\\[60\\]");

  it("does not enter drag mode until the pointer actually moves", async () => {
    renderSidebar(project);
    const handle = screen.getByRole("separator", { name: /resize sidebar/i });

    // 按下但不移动：不能进入拖拽态。一进入就挂全屏遮罩，分隔条收不到双击，
    // 「双击复位宽度」就失效了。
    fireEvent.mouseDown(handle, { clientX: 300 });
    expect(dragOverlay()).toBeNull();
    fireEvent.mouseUp(document);

    // 真的拖动（超过阈值）后才进入拖拽态。
    fireEvent.mouseDown(handle, { clientX: 300 });
    fireEvent.mouseMove(document, { clientX: 340 });
    await waitFor(() => expect(dragOverlay()).not.toBeNull());
    fireEvent.mouseUp(document);

    await waitFor(() => expect(dragOverlay()).toBeNull());
  });

  it("ignores pointer jitter below the drag threshold", async () => {
    renderSidebar(project);
    const handle = screen.getByRole("separator", { name: /resize sidebar/i });

    fireEvent.mouseDown(handle, { clientX: 300 });
    // 1px 抖动（双击时手抖的常见幅度）不应被当成拖拽。
    fireEvent.mouseMove(document, { clientX: 301 });
    await Promise.resolve();
    expect(dragOverlay()).toBeNull();

    fireEvent.mouseUp(document);
  });
});
