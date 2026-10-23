// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../../types/app";
import { authenticatedFetch } from "../../../utils/api";
import type { SlashCommand } from "./useSlashCommands";
import { useSlashCommands } from "./useSlashCommands";
import { handleCommandMenuKeyDown } from "./slashCommandInteractions";

vi.mock("../../../utils/api", () => ({ authenticatedFetch: vi.fn() }));

const mockedFetch = vi.mocked(authenticatedFetch);

type SlashCommandsProps = Parameters<typeof useSlashCommands>[0];

const PROJECT = { name: "proj", path: "/tmp/proj", fullPath: "/tmp/proj" } as Project;

const COMMAND_RESPONSE = {
  builtIn: [
    { name: "/gamma", description: "Pinned command", namespace: "builtin" },
    { name: "/alpha", description: "Alpha command", namespace: "builtin" },
  ],
  custom: [{ name: "/beta", description: "Beta command", namespace: "custom" }],
  pinned: [{ name: "/gamma" }],
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function createProps(overrides: Partial<SlashCommandsProps> = {}) {
  let input = "";
  const setInput = vi.fn((update: string | ((previous: string) => string)) => {
    input = typeof update === "function" ? update(input) : update;
  });
  const textarea = document.createElement("textarea");
  document.body.appendChild(textarea);

  const props: SlashCommandsProps = {
    selectedProject: PROJECT,
    input: "",
    setInput,
    textareaRef: { current: textarea },
    inputValueRef: { current: "" },
    ...overrides,
  };

  return {
    props,
    textarea,
    readInput: () => input,
    writeInput: (value: string) => {
      input = value;
      props.input = value;
    },
  };
}

function keyEvent(key: string) {
  return { key, preventDefault: vi.fn() };
}

function pinCommands() {
  mockedFetch.mockResolvedValue({
    ok: true,
    json: async () => COMMAND_RESPONSE,
  } as Response);
}

beforeEach(() => {
  localStorage.clear();
  mockedFetch.mockReset();
});

describe("useSlashCommands", () => {
  it("loads commands, maps built-in/custom types and orders pinned first then by usage", async () => {
    localStorage.setItem("command_history_proj", JSON.stringify({ "/alpha": 5 }));
    pinCommands();

    const { props } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));

    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    expect(result.current.slashCommands.map(command => command.name)).toEqual(["/gamma", "/alpha", "/beta"]);
    expect(result.current.slashCommands.find(command => command.name === "/alpha")?.type).toBe("built-in");
    expect(result.current.slashCommands.find(command => command.name === "/beta")?.type).toBe("custom");
    expect(result.current.slashCommandsCount).toBe(3);
  });

  it("groups pinned, frequent and namespaced commands for display", async () => {
    localStorage.setItem("command_history_proj", JSON.stringify({ "/alpha": 3 }));
    pinCommands();

    const { props } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));

    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    expect(result.current.frequentCommands.map(command => command.name)).toEqual(["/alpha"]);
    expect(result.current.filteredCommands.map(command => command.name)).toEqual(["/alpha", "/gamma", "/beta"]);
    expect(result.current.filteredCommands.map(command => command.namespace)).toEqual([
      "frequent",
      "builtin",
      "custom",
    ]);
  });

  it("filters commands through the debounced query", async () => {
    pinCommands();

    const { props } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));
    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    act(() => result.current.handleCommandInputChange("/al", 3));
    expect(result.current.showCommandMenu).toBe(true);

    await act(async () => {
      await sleep(220);
    });

    expect(result.current.commandQuery).toBe("al");
    expect(result.current.filteredCommands.map(command => command.name)).toEqual(["/alpha"]);
  });

  it("navigates with arrow keys, selects with Enter and dismisses with Escape", () => {
    const commands: SlashCommand[] = [{ name: "/gamma" }, { name: "/alpha" }, { name: "/beta" }];
    let selectedCommandIndex = -1;
    const selectCommandFromKeyboard = vi.fn();
    const dismissCommandMenu = vi.fn();
    const resetCommandMenuState = vi.fn();
    const setSelectedCommandIndex = vi.fn((update: number | ((previous: number) => number)) => {
      selectedCommandIndex = typeof update === "function" ? update(selectedCommandIndex) : update;
    });
    const deps = () => ({
      showCommandMenu: true,
      displayedCommands: commands,
      resetCommandMenuState,
      dismissCommandMenu,
      selectCommandFromKeyboard,
      selectedCommandIndex,
      setSelectedCommandIndex,
    });

    expect(handleCommandMenuKeyDown(keyEvent("ArrowDown"), deps())).toBe(true);
    expect(selectedCommandIndex).toBe(0);
    expect(handleCommandMenuKeyDown(keyEvent("ArrowDown"), deps())).toBe(true);
    expect(selectedCommandIndex).toBe(1);
    expect(handleCommandMenuKeyDown(keyEvent("ArrowUp"), deps())).toBe(true);
    expect(selectedCommandIndex).toBe(0);

    expect(handleCommandMenuKeyDown(keyEvent("Enter"), deps())).toBe(true);
    expect(selectCommandFromKeyboard).toHaveBeenCalledWith(commands[0]);

    expect(handleCommandMenuKeyDown(keyEvent("Escape"), deps())).toBe(true);
    expect(dismissCommandMenu).toHaveBeenCalledTimes(1);

    expect(handleCommandMenuKeyDown(keyEvent("Enter"), { ...deps(), showCommandMenu: false })).toBe(false);
    expect(handleCommandMenuKeyDown({ ...keyEvent("Enter"), isComposing: true }, deps())).toBe(false);
    expect(selectCommandFromKeyboard).toHaveBeenCalledTimes(1);
  });

  it("inserts the selected command and records usage", async () => {
    pinCommands();

    const { props, textarea, readInput } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));
    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    act(() => result.current.handleToggleCommandMenu());
    expect(result.current.showCommandMenu).toBe(true);

    act(() => result.current.handleCommandSelect({ name: "/gamma" }, 0, false));

    expect(readInput()).toBe("/gamma ");
    expect(result.current.showCommandMenu).toBe(false);
    expect(JSON.parse(localStorage.getItem("command_history_proj") ?? "{}")).toEqual({ "/gamma": 1 });

    // The real composer re-renders the textarea value from state before the
    // deferred focus callback runs; mirror that here so the caret can land.
    textarea.value = readInput();
    await act(async () => {
      await sleep(10);
    });
    expect(document.activeElement).toBe(textarea);
    expect(textarea.selectionStart).toBe("/gamma ".length);
  });

  it("preserves text after the slash query and the caret position", async () => {
    pinCommands();

    const { props, readInput, writeInput } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));
    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    writeInput("please /al now");
    act(() => result.current.handleCommandInputChange("please /al now", 10));
    await act(async () => {
      await sleep(220);
    });

    act(() => result.current.handleCommandSelect({ name: "/alpha" }, 0, false));

    expect(readInput()).toBe("please /alpha  now");
  });

  it("dismisses the menu by removing the typed slash query", async () => {
    pinCommands();

    const { props, readInput, writeInput } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));
    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    writeInput("please /al");
    act(() => result.current.handleCommandInputChange("please /al", 10));
    await act(async () => {
      await sleep(220);
    });

    act(() => result.current.dismissCommandMenu());

    expect(readInput()).toBe("please ");
    expect(result.current.showCommandMenu).toBe(false);
  });

  it("skips loading when no project is selected", () => {
    const { props } = createProps({ selectedProject: null });
    const { result } = renderHook(() => useSlashCommands(props));

    expect(mockedFetch).not.toHaveBeenCalled();
    expect(result.current.slashCommands).toEqual([]);
    expect(result.current.filteredCommands).toEqual([]);
  });

  it("clears the list when the command request fails", async () => {
    mockedFetch.mockRejectedValue(new Error("network down"));

    const { props } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));

    await waitFor(() => expect(mockedFetch).toHaveBeenCalledTimes(1));
    expect(result.current.slashCommands).toEqual([]);
  });

  it("keeps hover selection side-effect free", async () => {
    pinCommands();

    const { props, readInput } = createProps();
    const { result } = renderHook(() => useSlashCommands(props));
    await waitFor(() => expect(result.current.slashCommands).toHaveLength(3));

    act(() => result.current.handleCommandSelect({ name: "/alpha" } as SlashCommand, 2, true));

    expect(result.current.selectedCommandIndex).toBe(2);
    expect(readInput()).toBe("");
    expect(localStorage.getItem("command_history_proj")).toBeNull();
  });
});
