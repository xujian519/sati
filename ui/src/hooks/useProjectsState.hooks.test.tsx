// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppTab, Project, ProjectSession } from "../types/app";
import { useProjectOptimisticUpdates } from "./useProjectOptimisticUpdates";
import { useProjectSelectionActions } from "./useProjectSelectionActions";
import { useProjectSettingsPanel } from "./useProjectSettingsPanel";

const apiMocks = {
  sessions: vi.fn(),
};
const navigateMock = vi.fn();

vi.mock("../utils/api", () => ({
  api: {
    sessions: (...args: unknown[]) => apiMocks.sessions(...args),
  },
}));

function makeSession(id: string, overrides: Partial<ProjectSession> = {}): ProjectSession {
  return {
    id,
    title: `Session ${id}`,
    created_at: "2026-05-28T00:00:00.000Z",
    updated_at: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

function makeProject(name: string, sessionIds: string[], overrides: Partial<Project> = {}): Project {
  return {
    name,
    displayName: name,
    fullPath: `/tmp/${name}`,
    sessions: sessionIds.map(id => makeSession(id)),
    ...overrides,
  };
}

function useOptimisticHarness(initialProjects: Project[], initialSelected: Project | null = null) {
  const [projects, setProjects] = useState(initialProjects);
  const [selectedProject, setSelectedProject] = useState(initialSelected);
  const actions = useProjectOptimisticUpdates({ setProjects, setSelectedProject });
  return { projects, selectedProject, ...actions };
}

type SelectionHarnessArgs = {
  projects: Project[];
  sessionId?: string;
  activeTab?: AppTab;
  isMobile?: boolean;
  initialSelectedProject?: Project | null;
  initialSelectedSession?: ProjectSession | null;
};

function useSelectionHarness({
  projects: initialProjects,
  sessionId,
  activeTab: initialTab = "chat",
  isMobile = false,
  initialSelectedProject = null,
  initialSelectedSession = null,
}: SelectionHarnessArgs) {
  const [projects, setProjects] = useState(initialProjects);
  const [selectedProject, setSelectedProject] = useState(initialSelectedProject);
  const [selectedSession, setSelectedSession] = useState(initialSelectedSession);
  const [activeTab, setActiveTab] = useState<AppTab>(initialTab);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const projectsRef = useRef<Project[]>(projects);
  projectsRef.current = projects;
  const actions = useProjectSelectionActions({
    sessionId,
    projects,
    selectedProject,
    selectedSession,
    setProjects,
    setSelectedProject,
    setSelectedSession,
    setActiveTab,
    setSidebarOpen,
    projectsRef,
    navigate: navigateMock,
    isMobile,
    activeTab,
  });
  return { projects, selectedProject, selectedSession, activeTab, sidebarOpen, navigate: navigateMock, ...actions };
}

beforeEach(() => {
  apiMocks.sessions.mockReset();
  navigateMock.mockReset();
});

describe("useProjectSettingsPanel", () => {
  it("opens settings with the default tab", () => {
    const { result } = renderHook(() => useProjectSettingsPanel());

    expect(result.current.showSettings).toBe(false);
    expect(result.current.settingsInitialTab).toBe("appearance");

    act(() => result.current.openSettings());

    expect(result.current.showSettings).toBe(true);
    expect(result.current.settingsInitialTab).toBe("appearance");
  });

  it("opens settings on an explicit tab", () => {
    const { result } = renderHook(() => useProjectSettingsPanel());

    act(() => result.current.openSettings("providers"));

    expect(result.current.showSettings).toBe(true);
    expect(result.current.settingsInitialTab).toBe("providers");
  });
});

describe("useProjectOptimisticUpdates", () => {
  it("bumps an existing session and reorders it to the front", () => {
    const project = makeProject("alpha", ["s1", "s2"]);
    const { result } = renderHook(() => useOptimisticHarness([project], project));

    act(() => result.current.bumpSessionActivity("alpha", "s2"));

    const sessions = result.current.projects[0]?.sessions ?? [];
    expect(sessions.map(s => s.id)).toEqual(["s2", "s1"]);
    expect(sessions[0]?.updated_at).toBe(sessions[0]?.lastActivity);
    expect(result.current.selectedProject?.sessions?.[0]?.id).toBe("s2");
  });

  it("prepends a trimmed optimistic placeholder and increments the total", () => {
    const project = makeProject("alpha", ["s1"], { sessionMeta: { total: 1 } });
    const { result } = renderHook(() => useOptimisticHarness([project]));

    act(() => result.current.bumpSessionActivity("alpha", "new-session-1", "  hello   world  "));

    const sessions = result.current.projects[0]?.sessions ?? [];
    expect(sessions[0]).toMatchObject({
      id: "new-session-1",
      title: "hello world",
      messageCount: 0,
      __projectName: "alpha",
    });
    expect(result.current.projects[0]?.sessionMeta?.total).toBe(2);
    expect(result.current.selectedProject).toBeNull();
  });

  it("truncates optimistic titles to 80 characters", () => {
    const project = makeProject("alpha", []);
    const { result } = renderHook(() => useOptimisticHarness([project]));

    act(() => result.current.bumpSessionActivity("alpha", "new-session-1", "x".repeat(100)));

    expect(result.current.projects[0]?.sessions?.[0]?.title).toBe("x".repeat(80));
  });

  it("replaces the optimistic placeholder in place once the real id arrives", () => {
    const project = makeProject("alpha", ["new-session-1", "s1"]);
    const { result } = renderHook(() => useOptimisticHarness([project], project));

    act(() => result.current.replaceOptimisticInProjects("web:s_9"));

    const sessions = result.current.projects[0]?.sessions ?? [];
    expect(sessions.map(s => s.id)).toEqual(["web:s_9", "s1"]);
    expect(result.current.selectedProject?.sessions?.[0]?.id).toBe("web:s_9");
  });

  it("drops the placeholder when the real session is already present", () => {
    const project = makeProject("alpha", ["new-session-1", "s1"]);
    const { result } = renderHook(() => useOptimisticHarness([project]));

    act(() => result.current.replaceOptimisticInProjects("s1"));

    expect(result.current.projects[0]?.sessions?.map(s => s.id)).toEqual(["s1"]);
  });

  it("only accepts real ids when replacing optimistic rows", () => {
    const project = makeProject("alpha", ["new-session-1"]);
    const { result } = renderHook(() => useOptimisticHarness([project]));

    act(() => result.current.replaceOptimisticInProjects("new-session-2"));

    expect(result.current.projects[0]?.sessions?.map(s => s.id)).toEqual(["new-session-1"]);
  });

  it("drops a placeholder on abort without touching real sessions", () => {
    const project = makeProject("alpha", ["new-session-1", "s1"]);
    const { result } = renderHook(() => useOptimisticHarness([project], project));

    act(() => result.current.dropOptimisticInProjects("new-session-1"));

    expect(result.current.projects[0]?.sessions?.map(s => s.id)).toEqual(["s1"]);
    expect(result.current.selectedProject?.sessions?.map(s => s.id)).toEqual(["s1"]);

    act(() => result.current.dropOptimisticInProjects("s1"));
    expect(result.current.projects[0]?.sessions?.map(s => s.id)).toEqual(["s1"]);
  });

  it("resets an over-long session preview for a single project", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => makeSession(`s${index}`));
    const project: Project = {
      name: "alpha",
      displayName: "alpha",
      fullPath: "/tmp/alpha",
      sessions,
    };
    const other = makeProject("beta", ["b1", "b2", "b3", "b4", "b5", "b6"]);
    const { result } = renderHook(() => useOptimisticHarness([project, other], project));

    act(() => result.current.handleResetProjectSessionPreview("alpha"));

    expect(result.current.projects[0]?.sessions).toHaveLength(5);
    expect(result.current.projects[0]?.sessionMeta).toMatchObject({ total: 8, hasMore: true });
    expect(result.current.projects[1]?.sessions).toHaveLength(6);
    expect(result.current.selectedProject?.sessions).toHaveLength(5);
  });
});

describe("useProjectSelectionActions", () => {
  it("selects the project and session matching the route session id", () => {
    const alpha = makeProject("alpha", ["s1", "s2"]);
    const { result } = renderHook(() => useSelectionHarness({ projects: [alpha], sessionId: "s2" }));

    expect(result.current.selectedProject?.name).toBe("alpha");
    expect(result.current.selectedSession?.id).toBe("s2");
  });

  it("switches tasks/preview back to chat and navigates on session select", () => {
    const alpha = makeProject("alpha", ["s1"]);
    const { result } = renderHook(() => useSelectionHarness({ projects: [alpha], activeTab: "tasks" }));

    act(() => result.current.handleSessionSelect(makeSession("s1")));

    expect(result.current.activeTab).toBe("chat");
    expect(result.current.selectedSession?.id).toBe("s1");
    expect(result.current.navigate).toHaveBeenCalledWith("/session/s1");
  });

  it("closes the sidebar on mobile only when switching projects", () => {
    const alpha = makeProject("alpha", ["s1"]);
    const beta = makeProject("beta", ["b1"]);
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha, beta],
        isMobile: true,
        initialSelectedProject: alpha,
      }),
    );

    act(() => result.current.handleSessionSelect(makeSession("s1", { __projectName: "alpha" })));
    expect(result.current.sidebarOpen).toBe(true);

    act(() => result.current.handleSessionSelect(makeSession("b1", { __projectName: "beta" })));
    expect(result.current.sidebarOpen).toBe(false);
  });

  it("clears the selection and decrements the total when deleting the active session", () => {
    const alpha = makeProject("alpha", ["s1", "s2"], { sessionMeta: { total: 2 } });
    const selected = makeSession("s1");
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha],
        initialSelectedProject: alpha,
        initialSelectedSession: selected,
      }),
    );

    act(() => result.current.handleSessionDelete("s1"));

    expect(result.current.selectedSession).toBeNull();
    expect(result.current.navigate).toHaveBeenCalledWith("/");
    expect(result.current.projects[0]?.sessions?.map(s => s.id)).toEqual(["s2"]);
    expect(result.current.projects[0]?.sessionMeta?.total).toBe(1);
  });

  it("keeps the selection when deleting a different session", () => {
    const alpha = makeProject("alpha", ["s1", "s2"], { sessionMeta: { total: 2 } });
    const selected = makeSession("s1");
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha],
        initialSelectedProject: alpha,
        initialSelectedSession: selected,
      }),
    );

    act(() => result.current.handleSessionDelete("s2"));

    expect(result.current.selectedSession?.id).toBe("s1");
    expect(result.current.navigate).not.toHaveBeenCalled();
    expect(result.current.projects[0]?.sessionMeta?.total).toBe(1);
  });

  it("clears and navigates when deleting the selected project", () => {
    const alpha = makeProject("alpha", ["s1"]);
    const beta = makeProject("beta", ["b1"]);
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha, beta],
        initialSelectedProject: alpha,
        initialSelectedSession: makeSession("s1"),
      }),
    );

    act(() => result.current.handleProjectDelete("alpha"));

    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedSession).toBeNull();
    expect(result.current.navigate).toHaveBeenCalledWith("/");
    expect(result.current.projects.map(p => p.name)).toEqual(["beta"]);
  });

  it("deselects the project and resets every session preview", () => {
    const sessions = Array.from({ length: 8 }, (_, index) => makeSession(`s${index}`));
    const alpha: Project = {
      name: "alpha",
      displayName: "alpha",
      fullPath: "/tmp/alpha",
      sessions,
    };
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha],
        initialSelectedProject: alpha,
        initialSelectedSession: sessions[0],
      }),
    );

    act(() => result.current.handleDeselectProject());

    expect(result.current.selectedProject).toBeNull();
    expect(result.current.selectedSession).toBeNull();
    expect(result.current.navigate).toHaveBeenCalledWith("/");
    expect(result.current.projects[0]?.sessions).toHaveLength(5);
  });

  it("merges a page of sessions without duplicates and refreshes the selection", async () => {
    const alpha = makeProject("alpha", ["s1", "s2", "s3", "s4", "s5"], { sessionMeta: { total: 6, hasMore: true } });
    apiMocks.sessions.mockResolvedValue({
      ok: true,
      json: async () => ({
        sessions: [makeSession("web:s_6"), makeSession("s1")],
        hasMore: false,
        total: 6,
      }),
    });
    const { result } = renderHook(() =>
      useSelectionHarness({
        projects: [alpha],
        initialSelectedProject: alpha,
        initialSelectedSession: alpha.sessions?.[0] ?? null,
      }),
    );

    await act(async () => {
      await result.current.loadMoreSessions("alpha");
    });

    const sessions = result.current.projects[0]?.sessions ?? [];
    expect(sessions.map(s => s.id)).toEqual(["s1", "s2", "s3", "s4", "s5", "web:s_6"]);
    expect(result.current.projects[0]?.sessionMeta).toMatchObject({ total: 6, hasMore: false });
    expect(result.current.selectedProject?.sessions).toHaveLength(6);
    expect(result.current.loadingMoreProjectIds.size).toBe(0);
    expect(apiMocks.sessions).toHaveBeenCalledWith("alpha", 30, 5);
  });

  it("skips the request when the project reports no more sessions", async () => {
    const alpha = makeProject("alpha", ["s1"], { sessionMeta: { total: 1, hasMore: false } });
    const { result } = renderHook(() => useSelectionHarness({ projects: [alpha] }));

    await act(async () => {
      await result.current.loadMoreSessions("alpha");
    });

    expect(apiMocks.sessions).not.toHaveBeenCalled();
  });
});
