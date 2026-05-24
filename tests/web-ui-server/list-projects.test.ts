import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWebProjects, describeWebProject } from "../../src/web/server/listProjects.js";
import { createCollisionResistantProjectId, createProjectId } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";

test("listWebProjects always includes the default project root", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-listp-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  try {
    const result = await listWebProjects({ pilotHome, defaultProjectRoot: projectRoot });
    assert.ok(result.projects.length >= 1);
    assert.equal(result.projects[0].fullPath, projectRoot);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("listWebProjects surfaces session counts when chats exist", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-listp-sessions-"));
  const projectRoot = join(pilotHome, "fake-project");
  mkdirSync(projectRoot, { recursive: true });
  const projectId = createProjectId(projectRoot);
  const chatDir = join(pilotHome, "projects", projectId, "chats");
  mkdirSync(chatDir, { recursive: true });
  // Fake JSONL with a single accepted_input so listProjectSessions counts it.
  const session = {
    type: "accepted_input",
    sessionId: "web:demo",
    turnId: "t-1",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const safeSessionFile = sanitizeSessionIdForPath("web:demo");
  writeFileSync(join(chatDir, `${safeSessionFile}.jsonl`), JSON.stringify(session) + "\n");
  try {
    const result = await listWebProjects({ pilotHome, defaultProjectRoot: projectRoot });
    const found = result.projects.find((p) => p.fullPath === projectRoot);
    assert.ok(found);
    assert.equal(found?.sessionCount, 1);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("describeWebProject returns a stable summary even for missing projects", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-describe-"));
  try {
    const summary = await describeWebProject("/nonexistent-project", {
      pilotHome,
      defaultProjectRoot: pilotHome,
    });
    assert.equal(summary.projectKey, "/nonexistent-project");
    assert.equal(summary.sessionCount, 0);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});

test("createCollisionResistantProjectId disambiguates paths that collide under legacy encoding", () => {
  const dashed = "/Users/miwi/claude-code";
  const nested = "/Users/miwi/claude/code";
  assert.equal(createProjectId(dashed), createProjectId(nested));
  assert.notEqual(createCollisionResistantProjectId(dashed), createCollisionResistantProjectId(nested));
});

test("listWebProjects prefers .cwd marker when resolving a project id", async () => {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-listp-cwd-marker-"));
  const workspace = join(pilotHome, "workspace-zh-proxy");
  const opaqueProjectId = createProjectId(workspace);
  mkdirSync(workspace, { recursive: true });
  const projectDir = join(pilotHome, "projects", opaqueProjectId);
  const chatDir = join(projectDir, "chats");
  mkdirSync(chatDir, { recursive: true });
  writeFileSync(join(projectDir, ".cwd"), workspace + "\n");
  const session = {
    type: "accepted_input",
    sessionId: "web:opaque-marker",
    turnId: "t-1",
    sequence: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "user", content: [{ type: "text", text: "marker" }] }],
  };
  const safeMarkerFile = sanitizeSessionIdForPath("web:opaque-marker");
  writeFileSync(join(chatDir, `${safeMarkerFile}.jsonl`), JSON.stringify(session) + "\n");
  try {
    const result = await listWebProjects({ pilotHome, defaultProjectRoot: workspace });
    const found = result.projects.find((p) => p.fullPath === workspace);
    assert.ok(found);
    assert.equal(found?.sessionCount, 1);
  } finally {
    rmSync(pilotHome, { recursive: true, force: true });
  }
});
