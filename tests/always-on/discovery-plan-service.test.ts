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

test("queueExecution throws NOT_FOUND for missing plan", async () => {
  const env = makeTestEnv();
  try {
    await assert.rejects(
      () => env.service.queueExecution("test-project", "nonexistent"),
      (error: Error & { code?: string }) => error.code === "NOT_FOUND",
    );
  } finally {
    env.cleanup();
  }
});

test("queueExecution throws INVALID_STATE for superseded plan", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Old plan", status: "superseded", planFilePath: "plans/p1.md" },
    ]);
    writePlanBody(env.plansDir, "p1", "body");
    await assert.rejects(
      () => env.service.queueExecution("test-project", "p1"),
      (error: Error & { code?: string }) => error.code === "INVALID_STATE",
    );
  } finally {
    env.cleanup();
  }
});

test("queueExecution throws MISSING_PLAN_BODY for empty plan", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Empty plan", status: "ready", planFilePath: "plans/p1.md" },
    ]);
    writePlanBody(env.plansDir, "p1", "");
    await assert.rejects(
      () => env.service.queueExecution("test-project", "p1"),
      (error: Error & { code?: string }) => error.code === "MISSING_PLAN_BODY",
    );
  } finally {
    env.cleanup();
  }
});

test("queueExecution queues a ready plan and emits events", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Good plan", status: "ready", planFilePath: "plans/p1.md" },
    ]);
    writePlanBody(env.plansDir, "p1", "Do the thing");

    const result = await env.service.queueExecution("test-project", "p1");
    assert.equal(result.plan.status, "queued");
    assert.ok(result.executionToken);
    assert.ok(result.command.includes("Do the thing"));
    assert.ok(env.events.length > 0);
    assert.equal(env.events[0]!.status, "queued");
  } finally {
    env.cleanup();
  }
});

test("archive throws INVALID_STATE for running plan", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Running", status: "running", planFilePath: "plans/p1.md" },
    ]);
    await assert.rejects(
      () => env.service.archive("test-project", "p1"),
      (error: Error & { code?: string }) => error.code === "INVALID_STATE",
    );
  } finally {
    env.cleanup();
  }
});

test("archive marks a plan as superseded", async () => {
  const env = makeTestEnv();
  try {
    writePlanIndex(env.plansDir, [
      { id: "p1", title: "Done", status: "completed", planFilePath: "plans/p1.md" },
    ]);
    const result = await env.service.archive("test-project", "p1");
    assert.deepEqual(result, { archived: true });

    const raw = readFileSync(join(env.plansDir, "index.json"), "utf8");
    const stored = JSON.parse(raw);
    assert.equal(stored.plans[0].status, "superseded");
  } finally {
    env.cleanup();
  }
});
