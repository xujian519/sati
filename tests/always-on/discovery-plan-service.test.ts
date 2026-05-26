import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { DiscoveryPlanService, type WebPlanRecord } from "../../src/always-on/web/DiscoveryPlanService.js";

function createProjectId(projectRoot: string): string {
  return resolve(projectRoot).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function makeTestEnv() {
  const pilotHome = mkdtempSync(join(tmpdir(), "pilotdeck-plan-svc-"));
  const projectRoot = join(pilotHome, "_project");
  mkdirSync(projectRoot, { recursive: true });
  const projectId = createProjectId(projectRoot);
  const projectDir = join(pilotHome, "always-on", "projects", projectId);
  const plansDir = join(projectDir, "plans");
  mkdirSync(plansDir, { recursive: true });

  const events: Array<Record<string, unknown>> = [];
  const logs: string[][] = [];
  const logEvents: Array<Record<string, unknown>> = [];

  const service = new DiscoveryPlanService({
    pilotHome,
    createProjectId,
    paths: { extractProjectDirectory: async () => projectRoot },
    sessions: { getSessions: async () => ({ sessions: [] }) },
    activity: { isSessionActive: () => false },
    events: {
      appendRunEvent: async (_root, event) => { events.push(event); },
      appendRunLog: async (_root, _runId, lines) => { logs.push(lines); },
      appendRunLogEvent: async (_root, _runId, event) => { logEvents.push(event); },
      formatLogLine: (entry) => `[${entry.phase}] ${entry.message}`,
    },
  });

  return { pilotHome, projectRoot, projectDir, plansDir, service, events, logs, logEvents, cleanup: () => rmSync(pilotHome, { recursive: true, force: true }) };
}

function writePlanIndex(plansDir: string, plans: Array<Partial<WebPlanRecord>>) {
  writeFileSync(
    join(plansDir, "index.json"),
    JSON.stringify({ schemaVersion: 1, plans }),
  );
}

function writePlanBody(plansDir: string, planId: string, content: string) {
  writeFileSync(join(plansDir, `${planId}.md`), content);
}

test("getPlansOverview returns empty for no plans", async () => {
  const env = makeTestEnv();
  try {
    const result = await env.service.getPlansOverview("test-project");
    assert.deepEqual(result.plans, []);
  } finally {
    env.cleanup();
  }
});

test("getPlansOverview returns sorted plans with body", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Plan A", status: "ready", createdAt: "2026-05-08T10:00:00Z", updatedAt: "2026-05-08T10:00:00Z", planFilePath: "plans/p1.md" },
      { id: "p2", title: "Plan B", status: "running", createdAt: "2026-05-08T11:00:00Z", updatedAt: "2026-05-08T11:00:00Z", planFilePath: "plans/p2.md" },
    ]);
    writePlanBody(env.plansDir, "p1", "Plan A body");
    writePlanBody(env.plansDir, "p2", "Plan B body");

    const result = await env.service.getPlansOverview("test-project");
    assert.equal(result.plans.length, 2);
    assert.equal(result.plans[0]!.id, "p2");
    assert.equal(result.plans[0]!.status, "running");
  } finally {
    env.cleanup();
  }
});


// ---- cycle-level archive/apply (per-plan archive/apply removed) ----

test("archiveCycle marks all cycle plans as archived", async () => {
  const env = makeTestEnv();
  try {
    const cyclesDir = join(env.projectDir, "cycles");
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(join(cyclesDir, "index.json"), JSON.stringify({
      schemaVersion: 1,
      cycles: [{
        id: "c1",
        projectKey: env.projectRoot,
        status: "active",
        workspace: { strategy: "snapshot-copy", cwd: "/tmp/ws", metadata: {} },
        planIds: ["p1"],
        createdAt: "2026-05-08T10:00:00Z",
        createdByRunId: "run-1",
      }],
    }));
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Done plan", status: "completed", planFilePath: "plans/p1.md" },
    ]);

    const result = await env.service.archiveCycle("test-project", "c1");
    assert.deepEqual(result, { archived: true });

    const planRaw = readFileSync(join(env.plansDir, "index.json"), "utf8");
    const stored = JSON.parse(planRaw);
    assert.equal(stored.plans[0].status, "archived");
  } finally {
    env.cleanup();
  }
});

test("queueCycleApply rejects non-active cycle", async () => {
  const env = makeTestEnv();
  try {
    const cyclesDir = join(env.projectDir, "cycles");
    mkdirSync(cyclesDir, { recursive: true });
    writeFileSync(join(cyclesDir, "index.json"), JSON.stringify({
      schemaVersion: 1,
      cycles: [{
        id: "c1",
        projectKey: env.projectRoot,
        status: "archived",
        workspace: { strategy: "snapshot-copy", cwd: "/tmp/ws", metadata: {} },
        planIds: ["p1"],
        createdAt: "2026-05-08T10:00:00Z",
        createdByRunId: "run-1",
      }],
    }));
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Done plan", status: "completed", planFilePath: "plans/p1.md" },
    ]);
    writePlanBody(env.plansDir, "p1", "Plan content");

    await assert.rejects(
      () => env.service.queueCycleApply("test-project", "c1"),
      (error: Error & { code?: string }) => error.code === "INVALID_STATE",
    );
  } finally {
    env.cleanup();
  }
});
