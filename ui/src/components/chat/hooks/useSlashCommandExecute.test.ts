// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/app";
import type { ChatMessage } from "../types/types";
import { authenticatedFetch } from "../../../utils/api";
import { useSlashCommandExecute, type CommandExecutionResult } from "./useSlashCommandExecute";

vi.mock("../../../utils/api", () => ({ authenticatedFetch: vi.fn() }));

const mockedFetch = vi.mocked(authenticatedFetch);

type ExecuteProps = Parameters<typeof useSlashCommandExecute>[0];

const PROJECT = { name: "proj", path: "/tmp/proj", fullPath: "/tmp/proj" } as Project;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function createProps(overrides: Partial<ExecuteProps> = {}) {
  const props: ExecuteProps = {
    selectedProject: PROJECT,
    currentSessionId: "sess-1",
    model: "test-model",
    tokenBudget: null,
    input: "/help",
    addMessage: vi.fn(),
    clearMessages: vi.fn(),
    rewindMessages: vi.fn(),
    onFileOpen: vi.fn(),
    onShowSettings: vi.fn(),
    applyInputValue: vi.fn(),
    handleSubmitRef: { current: vi.fn() },
    ...overrides,
  };
  return props;
}

function respond(result: CommandExecutionResult) {
  mockedFetch.mockResolvedValue({ ok: true, status: 200, json: async () => result } as Response);
}

function addedMessages(props: ExecuteProps): ChatMessage[] {
  return vi.mocked(props.addMessage).mock.calls.map(([message]) => message);
}

function lastAssistantContent(props: ExecuteProps): string {
  const messages = addedMessages(props).filter(message => message.type === "assistant");
  return String(messages.at(-1)?.content ?? "");
}

beforeEach(() => {
  localStorage.clear();
  mockedFetch.mockReset();
  vi.restoreAllMocks();
  delete window.switchProject;
});

describe("useSlashCommandExecute", () => {
  it("posts the command with parsed args and renders a built-in response", async () => {
    respond({ type: "builtin", action: "help", data: { content: "Help text" } });
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    await act(async () => {
      await result.current.executeCommand({ name: "/help", path: "/tmp/help.md" }, "/help topics");
    });

    expect(mockedFetch).toHaveBeenCalledWith(
      "/api/commands/execute",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          commandName: "/help",
          commandPath: "/tmp/help.md",
          args: ["topics"],
          rawArgs: "topics",
          rawInput: "/help topics",
          context: {
            projectPath: "/tmp/proj",
            projectName: "proj",
            sessionId: "sess-1",
            model: "test-model",
            tokenUsage: null,
          },
        }),
      }),
    );
    expect(lastAssistantContent(props)).toBe("Help text");
    expect(props.applyInputValue).toHaveBeenCalledWith("");
  });

  it("formats model and cost payloads", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    respond({
      type: "builtin",
      action: "model",
      data: { current: { model: "gpt-x" }, available: { openai: ["a", "b"], empty: [] } },
    });
    await act(async () => {
      await result.current.executeCommand({ name: "/model" }, "/model");
    });
    expect(lastAssistantContent(props)).toContain("**Current Model**: gpt-x");
    expect(lastAssistantContent(props)).toContain("openai: a, b");
    expect(lastAssistantContent(props)).not.toContain("empty:");

    respond({
      type: "builtin",
      action: "cost",
      data: {
        tokenUsage: { used: 1200, total: 2000, percentage: 60 },
        cost: { input: "0.01", output: "0.02", total: "0.03" },
        model: "gpt-x",
      },
    });
    await act(async () => {
      await result.current.executeCommand({ name: "/cost" }, "/cost");
    });
    expect(lastAssistantContent(props)).toContain("**Token Usage**: 1,200 / 2,000 (60%)");
    expect(lastAssistantContent(props)).toContain("- **Total**: $0.03");
  });

  it("opens settings for /config and rewinds messages for /rewind", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    respond({ type: "builtin", action: "config" });
    await act(async () => {
      await result.current.executeCommand({ name: "/config" }, "/config");
    });
    expect(props.onShowSettings).toHaveBeenCalledTimes(1);

    respond({ type: "builtin", action: "rewind", data: { steps: 2, message: "Rewound." } });
    await act(async () => {
      await result.current.executeCommand({ name: "/rewind" }, "/rewind 2");
    });
    expect(props.rewindMessages).toHaveBeenCalledWith(4);
    expect(lastAssistantContent(props)).toBe("Rewound 2 step(s). Rewound.");
  });

  it("opens memory files only when they exist", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    respond({ type: "builtin", action: "memory", data: { message: "Memory ok", path: "/mem/x.md", exists: true } });
    await act(async () => {
      await result.current.executeCommand({ name: "/memory" }, "/memory");
    });
    expect(props.onFileOpen).toHaveBeenCalledWith("/mem/x.md");

    respond({ type: "builtin", action: "memory", data: { error: true, message: "No memory" } });
    await act(async () => {
      await result.current.executeCommand({ name: "/memory" }, "/memory");
    });
    expect(lastAssistantContent(props)).toBe("Warning: No memory");
  });

  it("renders the installed skill summary and warnings", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    respond({
      type: "builtin",
      action: "skillInstall",
      data: {
        installed: true,
        slug: "demo",
        scope: "project",
        installPath: "/tmp/proj/.sati/skills/demo",
        skillMeta: { name: "Demo", version: "1.2.3", description: "Demo skill" },
        stdout: "installed",
        exitCode: 0,
      },
    });
    await act(async () => {
      await result.current.executeCommand({ name: "/skill_install" }, "/skill_install demo");
    });

    const content = lastAssistantContent(props);
    expect(content).toContain("✅ **Installed** `Demo` v1.2.3 (project scope)");
    expect(content).toContain("Path: `/tmp/proj/.sati/skills/demo`");
    expect(content).toContain("Demo skill");
    expect(content).toContain("installed");
    expect(content).toContain("open a fresh chat");

    respond({
      type: "builtin",
      action: "skillInstall",
      data: { needsForce: true, slug: "risky", retryCommand: "/skill_install risky --force" },
    });
    await act(async () => {
      await result.current.executeCommand({ name: "/skill_install" }, "/skill_install risky");
    });
    expect(lastAssistantContent(props)).toContain("flagged as suspicious by VirusTotal");
    expect(lastAssistantContent(props)).toContain("/skill_install risky --force");
  });

  it("resolves switchProject through the browser-global helper", async () => {
    const switchProject = vi.fn(() => true);
    window.switchProject = switchProject;
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    respond({ type: "builtin", action: "switchProject", data: { projectName: "other" } });
    await act(async () => {
      await result.current.executeCommand({ name: "/project" }, "/project other");
    });

    expect(switchProject).toHaveBeenCalledWith("other");
    expect(lastAssistantContent(props)).toBe("Switched to project: `other`");

    switchProject.mockReturnValue(false);
    await act(async () => {
      await result.current.executeCommand({ name: "/project" }, "/project other");
    });
    expect(lastAssistantContent(props)).toContain("No project matched `other`");
  });

  it("applies custom command content and defers submission", async () => {
    respond({ type: "custom", content: "/skill demo", metadata: { passthrough: true } });
    const submit = vi.fn();
    const props = createProps({ handleSubmitRef: { current: submit } });
    const { result } = renderHook(() => useSlashCommandExecute(props));

    await act(async () => {
      await result.current.executeCommand({ name: "/skill" }, "/skill demo");
    });

    expect(props.applyInputValue).toHaveBeenCalledWith("/skill demo");
    expect(result.current.skipSlashDetectionOnceRef.current).toBe(true);

    await act(async () => {
      await sleep(10);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit.mock.calls[0][0]).toEqual({ preventDefault: expect.any(Function) });
  });

  it("cancels bash-backed custom commands when the user declines", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    respond({ type: "custom", content: "/danger", hasBashCommands: true });
    const submit = vi.fn();
    const props = createProps({ handleSubmitRef: { current: submit } });
    const { result } = renderHook(() => useSlashCommandExecute(props));

    await act(async () => {
      await result.current.executeCommand({ name: "/danger" }, "/danger");
    });

    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(props.applyInputValue).not.toHaveBeenCalled();
    expect(lastAssistantContent(props)).toBe("Command execution cancelled");

    await act(async () => {
      await sleep(10);
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it("surfaces server and transport errors as assistant messages", async () => {
    const props = createProps();
    const { result } = renderHook(() => useSlashCommandExecute(props));

    mockedFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ message: "boom" }) } as Response);
    await act(async () => {
      await result.current.executeCommand({ name: "/help" }, "/help");
    });
    expect(lastAssistantContent(props)).toBe("Error executing command: boom");

    mockedFetch.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await result.current.executeCommand({ name: "/help" }, "/help");
    });
    expect(lastAssistantContent(props)).toBe("Error executing command: offline");
  });

  it("ignores execution without a command or project", async () => {
    const props = createProps({ selectedProject: null });
    const { result } = renderHook(() => useSlashCommandExecute(props));

    await act(async () => {
      await result.current.executeCommand(null as never, "/help");
    });
    expect(mockedFetch).not.toHaveBeenCalled();

    props.selectedProject = PROJECT;
    const { result: withProject } = renderHook(() => useSlashCommandExecute(props));
    await act(async () => {
      await withProject.current.executeCommand(null as never, "/help");
    });
    expect(mockedFetch).not.toHaveBeenCalled();
  });
});
