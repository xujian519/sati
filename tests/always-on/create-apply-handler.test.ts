import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApplyHandler } from "../../src/always-on/runtime/createApplyHandler.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";

function createProjectId(projectRoot: string): string {
  const normalized = resolve(projectRoot).replace(/\\/g, "/").replace(/^[A-Za-z]:/, "");
  return normalized.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function makeTestEnv() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-apply-handler-"));
  const projectRoot = join(pilotHome, "_project");
  mkdirSync(projectRoot, { recursive: true });
  const projectId = createProjectId(projectRoot);
  const projectDir = join(pilotHome, "always-on", "projects", projectId);
  const plansDir = join(projectDir, "plans");
  const cyclesDir = join(projectDir, "cycles");
  mkdirSync(plansDir, { recursive: true });
  mkdirSync(cyclesDir, { recursive: true });

  return {
    pilotHome,
    projectRoot,
    projectDir,
    plansDir,
    cyclesDir,
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
  };
}

function writeCycleIndex(cyclesDir: string, cycles: Array<Record<string, unknown>>) {
  writeFileSync(
    join(cyclesDir, "index.json"),
    JSON.stringify({ schemaVersion: 1, cycles }),
  );
}

function makeDummyGateway() {
  return {
    submitTurn: async function* () { yield { type: "done" as const, code: "", message: "" }; },
    abortTurn: async () => undefined,
    listSessions: async () => ({ sessions: [] }),
    resumeSession: async (i: unknown) => i,
    newSession: async () => ({ sessionKey: "test" }),
    closeSession: async () => undefined,
    describeServer: async () => ({ mode: "in_process" as const }),
    cronCreate: async () => { throw new Error("noop"); },
    cronList: async () => { throw new Error("noop"); },
    cronDelete: async () => { throw new Error("noop"); },
    cronStop: async () => { throw new Error("noop"); },
    cronRunNow: async () => { throw new Error("noop"); },
    respondElicitation: async () => ({ delivered: false }),
    permissionDecide: async () => ({ delivered: false }),
    grantSessionPermission: async () => ({ granted: false }),
    readSessionMessages: async () => { throw new Error("noop"); },
    listProjects: async () => ({ projects: [] }),
    describeProject: async () => ({ projectKey: "", name: "", fullPath: "", sessionCount: 0 }),
  };
}

test("createApplyHandler returns cycle_not_found for missing cycle", async () => {
  const env = makeTestEnv();
  try {
    writeCycleIndex(env.cyclesDir, []);

    const handler = createApplyHandler({
      gateway: makeDummyGateway() as never,
      pilotHome: env.pilotHome,
      sessionOverrides: new SessionConfigOverrides(),
    });

    const result = await handler({
      projectKey: env.projectRoot,
      workCycleId: "nonexistent",
      projectName: "test",
    });

    assert.ok(result.error);
    assert.equal(result.error.code, "cycle_not_found");
  } finally {
    env.cleanup();
  }
});

test("createApplyHandler returns missing_workspace for cycle without workspace", async () => {
  const env = makeTestEnv();
  try {
    writeCycleIndex(env.cyclesDir, [
      {
        id: "c1",
        projectKey: env.projectRoot,
        status: "active",
        workspace: { strategy: "snapshot-copy", cwd: "", metadata: {} },
        planIds: [],
        createdAt: "2026-05-08T10:00:00Z",
        createdByRunId: "run-1",
      },
    ]);

    const handler = createApplyHandler({
      gateway: makeDummyGateway() as never,
      pilotHome: env.pilotHome,
      sessionOverrides: new SessionConfigOverrides(),
    });

    const result = await handler({
      projectKey: env.projectRoot,
      workCycleId: "c1",
      projectName: "test",
    });

    assert.ok(result.error);
    assert.equal(result.error.code, "missing_workspace");
  } finally {
    env.cleanup();
  }
});
