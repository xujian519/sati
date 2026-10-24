// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project, ProjectSession } from "../../types/app";
import SidebarV2 from "./SidebarV2";

const general: Project = {
  name: "general",
  displayName: "general",
  fullPath: "/workspace/general",
  sessions: [],
};

const makeSession = (id: string, overrides: Partial<ProjectSession> = {}): ProjectSession => ({
  id,
  title: `Title ${id}`,
  lastActivity: "2026-10-20T10:00:00.000Z",
  ...overrides,
});

const makeProject = (sessions: ProjectSession[], overrides: Partial<Project> = {}): Project => ({
  name: "sati",
  displayName: "Sati",
  fullPath: "/workspace/Sati",
  sessions,
  ...overrides,
});

function renderSidebar(
  projects: Project[],
  props: Partial<ComponentProps<typeof SidebarV2>> = {},
  selectedProject: Project | null = projects.find(project => project.name === "sati") ?? null,
) {
  const merged: ComponentProps<typeof SidebarV2> = {
    projects,
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
    ...props,
  };
  const utils = render(
    <MemoryRouter>
      <SidebarV2 {...merged} />
    </MemoryRouter>,
  );
  return { ...utils, props: merged };
}

const projectRow = (label = "Sati") => {
  const node = screen.getByText(label);
  const button = node.closest("button");
  return { label: node, button: button as HTMLButtonElement, contextTarget: button?.parentElement as HTMLElement };
};

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("SidebarV2 session rows", () => {
  it("renders sessions for the selected project and forwards session clicks", () => {
    const sessions = [makeSession("s1"), makeSession("s2")];
    const { props } = renderSidebar([general, makeProject(sessions)]);

    const row = screen.getByText("Title s1").closest("button") as HTMLButtonElement;
    fireEvent.click(row);

    expect(props.onSelectSession).toHaveBeenCalledWith(expect.objectContaining({ name: "sati" }), "s1");
  });

  it("expands an unselected project so its sessions are visible after a click", () => {
    const sessions = [makeSession("s1")];
    renderSidebar([general, makeProject(sessions)], {}, null);

    expect(screen.queryByText("Title s1")).toBeNull();
    fireEvent.click(projectRow().button);
    expect(screen.getByText("Title s1")).toBeTruthy();
  });

  it("nests fork children and shows the parent label", () => {
    const sessions = [
      makeSession("parent", { title: "Parent Session" }),
      makeSession("child", { title: "Child Session", parentSessionId: "parent" }),
    ];
    renderSidebar([general, makeProject(sessions)]);

    expect(screen.getByText("Child Session")).toBeTruthy();
    expect(screen.getByText(/forked from Parent Session/)).toBeTruthy();
  });

  it("renders optimistic placeholder rows as disabled without a context menu", () => {
    const sessions = [makeSession("new-session-1", { title: "Pending" })];
    renderSidebar([general, makeProject(sessions)]);

    const button = screen.getByText("Pending").closest("button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByText("Sending…")).toBeTruthy();

    fireEvent.contextMenu(button);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("collapses long session lists to five rows and reports the hidden count", () => {
    const sessions = Array.from({ length: 7 }, (_, index) => makeSession(`s${index}`));
    renderSidebar([general, makeProject(sessions)]);

    fireEvent.click(screen.getByRole("button", { name: "Show less" }));

    expect(screen.queryByText("Title s6")).toBeNull();
    const showMore = screen.getByRole("button", { name: /Show more \(2\)/ });
    fireEvent.click(showMore);
    expect(screen.getByText("Title s6")).toBeTruthy();
  });

  it("loads more sessions through the page callback when the project has more", () => {
    const sessions = [makeSession("s1")];
    const onLoadMoreSessions = vi.fn();
    renderSidebar([general, makeProject(sessions, { sessionMeta: { hasMore: true, total: 9 } })], {
      onLoadMoreSessions,
    });

    fireEvent.click(screen.getByRole("button", { name: /Show more \(8\)/ }));

    expect(onLoadMoreSessions).toHaveBeenCalledWith("sati");
  });
});

describe("SidebarV2 context menu and rename", () => {
  it("deletes a project from the context menu", () => {
    const { props } = renderSidebar([general, makeProject([makeSession("s1")])]);

    fireEvent.contextMenu(projectRow().contextTarget);
    const menu = screen.getByRole("menu");
    fireEvent.click(within(menu).getByText("Delete"));

    expect(props.onRequestDeleteProject).toHaveBeenCalledWith(expect.objectContaining({ name: "sati" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renames a project inline and persists the custom name", () => {
    renderSidebar([general, makeProject([makeSession("s1")])]);

    fireEvent.contextMenu(projectRow().contextTarget);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Rename"));

    const input = screen.getByPlaceholderText("Rename - empty to reset") as HTMLInputElement;
    expect(input.value).toBe("Sati");
    fireEvent.change(input, { target: { value: "Sati Renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(JSON.parse(localStorage.getItem("sati:customProjectNames") ?? "{}")).toEqual({
      sati: "Sati Renamed",
    });
    expect(screen.getByText("Sati Renamed")).toBeTruthy();
  });

  it("cancels a session rename on Escape without writing a name", () => {
    const { props } = renderSidebar([general, makeProject([makeSession("s1")])]);

    fireEvent.contextMenu(screen.getByText("Title s1"));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Rename"));
    const input = screen.getByPlaceholderText("Rename - empty to reset");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByPlaceholderText("Rename - empty to reset")).toBeNull();
    expect(localStorage.getItem("sati:customSessionTitles")).toBeNull();
    expect(props.onRequestDeleteSession).not.toHaveBeenCalled();
  });

  it("ignores IME composition Enter while renaming", () => {
    renderSidebar([general, makeProject([makeSession("s1")])]);

    fireEvent.contextMenu(projectRow().contextTarget);
    fireEvent.click(within(screen.getByRole("menu")).getByText("Rename"));
    const input = screen.getByPlaceholderText("Rename - empty to reset");
    fireEvent.change(input, { target: { value: "入力中" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true, keyCode: 229 });

    expect(screen.getByPlaceholderText("Rename - empty to reset")).toBeTruthy();
    expect(localStorage.getItem("sati:customProjectNames")).toBeNull();
  });

  it("deletes a session from the context menu", () => {
    const session = makeSession("s1");
    const { props } = renderSidebar([general, makeProject([session])]);

    fireEvent.contextMenu(screen.getByText("Title s1"));
    fireEvent.click(within(screen.getByRole("menu")).getByText("Delete"));

    expect(props.onRequestDeleteSession).toHaveBeenCalledWith(expect.objectContaining({ name: "sati" }), session);
  });
});

describe("SidebarV2 ordering and sections", () => {
  it("sorts projects by most recent activity when the setting asks for date order", () => {
    localStorage.setItem("sati-settings", JSON.stringify({ projectSortOrder: "date" }));
    const older = makeProject([makeSession("old", { lastActivity: "2026-01-01T00:00:00.000Z" })], {
      name: "older",
      displayName: "Older",
      fullPath: "/workspace/older",
    });
    const newer = makeProject([makeSession("new", { lastActivity: "2026-10-01T00:00:00.000Z" })], {
      name: "newer",
      displayName: "Newer",
      fullPath: "/workspace/newer",
    });
    const { container } = renderSidebar([general, older, newer], {}, null);

    const labels = [...container.querySelectorAll("span.flex-1.truncate")].map(node => node.textContent);
    expect(labels.indexOf("Newer")).toBeLessThan(labels.indexOf("Older"));
  });

  it("switches to the General workspace and resets the project preview", () => {
    const onSelectProject = vi.fn();
    const onResetProjectSessionPreview = vi.fn();
    renderSidebar([general, makeProject([makeSession("s1")]), { ...general, sessions: [makeSession("g1")] }], {
      onSelectProject,
      onResetProjectSessionPreview,
    });

    fireEvent.click(screen.getByRole("tab", { name: "General" }));

    expect(onResetProjectSessionPreview).toHaveBeenCalledWith("general");
    expect(onSelectProject).toHaveBeenCalledWith(expect.objectContaining({ name: "general" }));
  });
});

describe("SidebarV2 resize persistence", () => {
  it("restores the stored width and resets it on double click", async () => {
    localStorage.setItem("sidebar-v2-width", "320");
    renderSidebar([general, makeProject([makeSession("s1")])]);
    const handle = screen.getByRole("separator", { name: /resize sidebar/i });
    const root = document.querySelector("[data-sidebar-v2-root]") as HTMLElement;

    expect(root.style.width).toBe("320px");
    fireEvent.doubleClick(handle);
    await waitFor(() => expect(root.style.width).toBe("248px"));
    expect(localStorage.getItem("sidebar-v2-width")).toBe("248");
  });
});
