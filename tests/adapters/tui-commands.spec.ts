import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { GatewaySessionInfo } from "../../src/gateway/index.js";
import { readPermissionSettings } from "../../src/permission/settings.js";
import type { TuiGatewaySurface } from "../../src/adapters/channel/tui/app/gatewaySurface.js";
import type { TuiAppState, TuiMessage } from "../../src/adapters/channel/tui/app/types.js";
import { buildPermissionEntry, handleCommand } from "../../src/adapters/channel/tui/app/tuiCommands.js";

function baseState(): TuiAppState {
  return {
    connection: "in_process",
    activeSessionKey: "s0",
    sessions: [],
    messages: [],
    activity: [],
    input: "",
    mode: "default",
    isRunning: false,
    helpOpen: false,
    helpTab: "shortcuts",
    settingsCursor: 0,
    scrollOffset: 0,
    focusedIndex: null,
    viewerContent: null,
    viewerTitle: "",
    pendingPermissions: [],
    dashboardMode: "closed",
    sidebarCursorIndex: 0,
    sidebarCollapsed: new Set(),
    sidebarGroupBy: "project",
  };
}

/** 把 setState 收敛到一个可变 state 上，测试直接读回最终状态。 */
function makeSetState(initial: TuiAppState): { setState: (a: unknown) => void; get: () => TuiAppState } {
  let state = initial;
  const setState = (action: unknown) => {
    state = typeof action === "function" ? (action as (c: TuiAppState) => TuiAppState)(state) : (action as TuiAppState);
  };
  return { setState, get: () => state };
}

function makeGateway(overrides: Partial<TuiGatewaySurface> = {}): TuiGatewaySurface {
  return {
    listSessions: async () => ({ sessions: [] as GatewaySessionInfo[] }),
    resumeSession: async () => ({ sessionKey: "s" }),
    readSessionMessages: async () => ({ messages: [] }),
    newSession: async () => ({ sessionKey: "new-1" }),
    submitTurn: () => ({
      async *[Symbol.asyncIterator]() {},
    }),
    permissionDecide: async () => ({ delivered: true }),
    abortTurn: async () => {},
    ...overrides,
  } as TuiGatewaySurface;
}

const noop = () => {};
const asyncNoop = async () => {};

test("handleCommand returns false for non-slash input (falls through to turn submit)", async () => {
  const { setState, get } = makeSetState(baseState());
  const handled = await handleCommand(
    "hello world",
    makeGateway(),
    "p",
    setState,
    noop,
    asyncNoop,
    [],
    asyncNoop,
    asyncNoop,
  );
  assert.equal(handled, false);
  assert.deepEqual(get().messages, []);
});

test("/new creates a session and points activeSessionKey at it", async () => {
  const { setState, get } = makeSetState(baseState());
  const handled = await handleCommand(
    "/new",
    makeGateway({ newSession: async () => ({ sessionKey: "fresh-42" }) }),
    "p",
    setState,
    noop,
    asyncNoop,
    [],
    asyncNoop,
    asyncNoop,
  );
  assert.equal(handled, true);
  assert.equal(get().activeSessionKey, "fresh-42");
  assert.match(get().messages.at(-1)!.text, /fresh-42/);
});

test("/switch N resolves the Nth session and delegates to switchToSession", async () => {
  const sessions = [
    { sessionKey: "a", sessionId: "a", summary: "first" },
    { sessionKey: "b", sessionId: "b", summary: "second" },
  ] as GatewaySessionInfo[];
  const switched: string[] = [];
  const { setState, get } = makeSetState(baseState());
  const handled = await handleCommand(
    "/switch 2",
    makeGateway({ listSessions: async () => ({ sessions }) }),
    "p",
    setState,
    noop,
    asyncNoop,
    [],
    asyncNoop,
    async (k: string) => {
      switched.push(k);
    },
  );
  assert.equal(handled, true);
  assert.deepEqual(switched, ["b"]);
  assert.equal(get().sessions.length, 2);
});

test("/sessions with no arg opens the sidebar", async () => {
  let opened = 0;
  const { setState } = makeSetState(baseState());
  await handleCommand(
    "/sessions",
    makeGateway(),
    "p",
    setState,
    noop,
    asyncNoop,
    [],
    async () => {
      opened += 1;
    },
    asyncNoop,
  );
  assert.equal(opened, 1);
});

test("/clear empties messages and resets focus", async () => {
  const initial = { ...baseState(), messages: [{ role: "user", text: "x" } as TuiMessage], focusedIndex: 0 };
  const { setState, get } = makeSetState(initial);
  await handleCommand("/clear", makeGateway(), "p", setState, noop, asyncNoop, [], asyncNoop, asyncNoop);
  assert.deepEqual(get().messages, []);
  assert.equal(get().focusedIndex, null);
});

test("/help toggles helpOpen", async () => {
  const { setState, get } = makeSetState(baseState());
  await handleCommand("/help", makeGateway(), "p", setState, noop, asyncNoop, [], asyncNoop, asyncNoop);
  assert.equal(get().helpOpen, true);
});

test("/exit invokes exit callback", async () => {
  let exited = 0;
  const { setState } = makeSetState(baseState());
  const handled = await handleCommand(
    "/exit",
    makeGateway(),
    "p",
    setState,
    () => {
      exited += 1;
    },
    asyncNoop,
    [],
    asyncNoop,
    asyncNoop,
  );
  assert.equal(handled, true);
  assert.equal(exited, 1);
});

test("unknown command appends an error message", async () => {
  const { setState, get } = makeSetState(baseState());
  const handled = await handleCommand(
    "/frobnicate",
    makeGateway(),
    "p",
    setState,
    noop,
    asyncNoop,
    [],
    asyncNoop,
    asyncNoop,
  );
  assert.equal(handled, true);
  assert.equal(get().messages.at(-1)!.role, "error");
  assert.match(get().messages.at(-1)!.text, /Unknown command \/frobnicate/);
});

test("/view opens the last qualifying tool output", async () => {
  const tools: TuiMessage[] = [
    { role: "tool", text: "short", toolName: "read_file", lineCount: 2 },
    { role: "tool", text: "long", toolName: "bash", lineCount: 99 },
  ];
  const opened: string[] = [];
  const { setState } = makeSetState(baseState());
  await handleCommand(
    "/view",
    makeGateway(),
    "p",
    setState,
    noop,
    async m => {
      opened.push(m.toolName ?? "");
    },
    tools,
    asyncNoop,
    asyncNoop,
  );
  // only the lineCount>4 tool qualifies → it is the sole/last target
  assert.deepEqual(opened, ["bash"]);
});

test("/permissions allow writes an entry (isolated SATI_HOME) and no-arg lists it", async () => {
  const home = mkdtempSync(join(tmpdir(), "sati-tui-cmds-"));
  const prev = process.env.SATI_HOME;
  process.env.SATI_HOME = home;
  try {
    const { setState, get } = makeSetState(baseState());
    await handleCommand(
      "/permissions allow Bash(git status:*)",
      makeGateway(),
      "p",
      setState,
      noop,
      asyncNoop,
      [],
      asyncNoop,
      asyncNoop,
    );
    assert.match(get().messages.at(-1)!.text, /Added allow/);
    // Bash(...) 形态会被 normalizePermissionEntry 规范为 bash:... 落盘
    assert.ok(readPermissionSettings().allowedTools.includes("bash:git status:*"));

    const { setState: setState2, get: get2 } = makeSetState(baseState());
    await handleCommand("/permissions", makeGateway(), "p", setState2, noop, asyncNoop, [], asyncNoop, asyncNoop);
    assert.match(get2().messages.at(-1)!.text, /bash:git status:\*/);
  } finally {
    if (prev === undefined) delete process.env.SATI_HOME;
    else process.env.SATI_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("/mode plan clears skipPermissions and records mode", async () => {
  const home = mkdtempSync(join(tmpdir(), "sati-tui-cmds-mode-"));
  const prev = process.env.SATI_HOME;
  process.env.SATI_HOME = home;
  try {
    const { setState, get } = makeSetState(baseState());
    await handleCommand("/mode plan", makeGateway(), "p", setState, noop, asyncNoop, [], asyncNoop, asyncNoop);
    assert.equal(get().mode, "plan");
    assert.match(get().messages.at(-1)!.text, /Mode: plan/);
  } finally {
    if (prev === undefined) delete process.env.SATI_HOME;
    else process.env.SATI_HOME = prev;
    rmSync(home, { recursive: true, force: true });
  }
});

test("buildPermissionEntry: non-bash is passthrough; bash takes first token (git two-level)", () => {
  assert.equal(buildPermissionEntry("read_file", {}), "read_file");
  assert.equal(buildPermissionEntry("bash", { command: "git commit -m x" }), "bash:git commit:*");
  assert.equal(buildPermissionEntry("bash", { command: "ls -la" }), "bash:ls:*");
  assert.equal(buildPermissionEntry("bash", { command: "   " }), "bash");
  assert.equal(buildPermissionEntry("bash", undefined), "bash");
});
