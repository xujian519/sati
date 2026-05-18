import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  groupSessionsByProject,
  computeSmartCollapse,
  flattenSidebarRows,
  sessionStatusIcon,
  sessionDisplayTitle,
  relativeTime,
} from "../../src/adapters/channel/tui/app/sidebar-helpers.js";
import type { GatewaySessionInfo } from "../../src/gateway/index.js";

function makeSession(overrides: Partial<GatewaySessionInfo> = {}): GatewaySessionInfo {
  return {
    sessionId: "s1",
    summary: "test session",
    lastModified: Date.now(),
    cwd: "/projects/alpha",
    ...overrides,
  };
}

describe("groupSessionsByProject", () => {
  it("groups sessions by cwd", () => {
    const sessions = [
      makeSession({ sessionId: "s1", cwd: "/a" }),
      makeSession({ sessionId: "s2", cwd: "/b" }),
      makeSession({ sessionId: "s3", cwd: "/a" }),
    ];
    const groups = groupSessionsByProject(sessions);
    assert.equal(groups.length, 2);
    const aGroup = groups.find((g) => g.groupKey === "/a");
    assert.equal(aGroup?.sessions.length, 2);
  });

  it("sorts groups by most recent session", () => {
    const sessions = [
      makeSession({ sessionId: "s1", cwd: "/old", lastModified: 1000 }),
      makeSession({ sessionId: "s2", cwd: "/new", lastModified: 9000 }),
    ];
    const groups = groupSessionsByProject(sessions);
    assert.equal(groups[0]!.groupKey, "/new");
  });

  it("uses last path segment as label", () => {
    const sessions = [makeSession({ cwd: "/Users/da/ws/PilotDeck" })];
    const groups = groupSessionsByProject(sessions);
    assert.equal(groups[0]!.label, "PilotDeck");
  });
});

describe("computeSmartCollapse", () => {
  it("returns empty set for single group", () => {
    const groups = [{ groupKey: "/a", label: "a", sessions: [makeSession()] }];
    const collapsed = computeSmartCollapse(groups, "s1");
    assert.equal(collapsed.size, 0);
  });

  it("collapses groups without active session", () => {
    const groups = [
      { groupKey: "/a", label: "a", sessions: [makeSession({ sessionId: "s1", sessionKey: "s1" })] },
      { groupKey: "/b", label: "b", sessions: [makeSession({ sessionId: "s2", sessionKey: "s2" })] },
    ];
    const collapsed = computeSmartCollapse(groups, "s1");
    assert.equal(collapsed.has("/a"), false);
    assert.equal(collapsed.has("/b"), true);
  });
});

describe("flattenSidebarRows", () => {
  it("shows all sessions for single group (no header)", () => {
    const groups = [
      { groupKey: "/a", label: "a", sessions: [makeSession({ sessionId: "s1" }), makeSession({ sessionId: "s2" })] },
    ];
    const rows = flattenSidebarRows(groups, new Set());
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.kind, "session");
  });

  it("adds headers for multiple groups", () => {
    const groups = [
      { groupKey: "/a", label: "a", sessions: [makeSession({ sessionId: "s1" })] },
      { groupKey: "/b", label: "b", sessions: [makeSession({ sessionId: "s2" })] },
    ];
    const rows = flattenSidebarRows(groups, new Set());
    assert.equal(rows.length, 4);
    assert.equal(rows[0]!.kind, "header");
    assert.equal(rows[1]!.kind, "session");
    assert.equal(rows[2]!.kind, "header");
    assert.equal(rows[3]!.kind, "session");
  });

  it("hides sessions in collapsed groups", () => {
    const groups = [
      { groupKey: "/a", label: "a", sessions: [makeSession({ sessionId: "s1" })] },
      { groupKey: "/b", label: "b", sessions: [makeSession({ sessionId: "s2" })] },
    ];
    const collapsed = new Set(["/b"]);
    const rows = flattenSidebarRows(groups, collapsed);
    assert.equal(rows.length, 3);
    const bHeader = rows.find((r) => r.kind === "header" && r.groupKey === "/b");
    assert.equal(bHeader!.kind, "header");
    if (bHeader!.kind === "header") assert.equal(bHeader!.collapsed, true);
  });
});

describe("sessionStatusIcon", () => {
  it("returns correct icon for running tag", () => {
    assert.equal(sessionStatusIcon(makeSession({ tag: "running" })), "✻");
  });

  it("defaults to idle icon for unknown tag", () => {
    assert.equal(sessionStatusIcon(makeSession({ tag: undefined })), "∙");
  });
});

describe("sessionDisplayTitle", () => {
  it("returns full title when short enough", () => {
    const s = makeSession({ summary: "hello" });
    assert.equal(sessionDisplayTitle(s, 20), "hello");
  });

  it("truncates long titles", () => {
    const s = makeSession({ summary: "a very long session title that exceeds" });
    const result = sessionDisplayTitle(s, 10);
    assert.equal(result.length, 10);
    assert.ok(result.endsWith("…"));
  });

  it("prefers customTitle over other fields", () => {
    const s = makeSession({ customTitle: "custom", aiTitle: "ai", summary: "sum" });
    assert.equal(sessionDisplayTitle(s, 20), "custom");
  });
});

describe("relativeTime", () => {
  it("shows seconds for recent times", () => {
    const result = relativeTime(Date.now() - 30_000);
    assert.ok(result.endsWith("s"));
  });

  it("shows minutes", () => {
    const result = relativeTime(Date.now() - 5 * 60_000);
    assert.equal(result, "5m");
  });

  it("shows hours", () => {
    const result = relativeTime(Date.now() - 3 * 3600_000);
    assert.equal(result, "3h");
  });

  it("shows days", () => {
    const result = relativeTime(Date.now() - 2 * 86400_000);
    assert.equal(result, "2d");
  });
});
