import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createApplyHandler } from "../../src/always-on/runtime/createApplyHandler.js";
import { SessionConfigOverrides } from "../../src/always-on/runtime/SessionConfigOverrides.js";

function createProjectId(projectRoot: string): string {
  return resolve(projectRoot).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function makeTestEnv() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-apply-handler-"));
  const projectRoot = join(pilotHome, "_project");
  mkdirSync(projectRoot, { recursive: true });
  const projectId = createProjectId(projectRoot);
  const projectDir = join(pilotHome, "always-on", "projects", projectId);
  const plansDir = join(projectDir, "plans");
  mkdirSync(plansDir, { recursive: true });

  return {
    pilotHome,
    projectRoot,
    projectDir,
    plansDir,
    cleanup: () => rmSync(pilotHome, { recursive: true, force: true }),
  };
}

function writePlanIndex(plansDir: string, plans: Array<Record<string, unknown>>) {
  writeFileSync(
    join(plansDir, "index.json"),
    JSON.stringify({ schemaVersion: 1, plans }),
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

test("createApplyHandler returns plan_not_found for missing plan", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, []);

    const handler = createApplyHandler({
      gateway: makeDummyGateway() as never,
      pilotHome: env.pilotHome,
      sessionOverrides: new SessionConfigOverrides(),
    });

    const result = await handler({
      projectKey: env.projectRoot,
      planId: "nonexistent",
      projectName: "test",
    });

    assert.ok(result.error);
    assert.equal(result.error.code, "plan_not_found");
  } finally {
    env.cleanup();
  }
});

test("createApplyHandler returns missing_workspace for plan without workspace", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "No workspace plan", status: "completed" },
    ]);

    const handler = createApplyHandler({
      gateway: makeDummyGateway() as never,
      pilotHome: env.pilotHome,
      sessionOverrides: new SessionConfigOverrides(),
    });

    const result = await handler({
      projectKey: env.projectRoot,
      planId: "p1",
      projectName: "test",
    });

    assert.ok(result.error);
    assert.equal(result.error.code, "missing_workspace");
  } finally {
    env.cleanup();
  }
});
