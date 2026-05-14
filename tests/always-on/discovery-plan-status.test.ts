import assert from "node:assert/strict";
import test from "node:test";
import {
  computeExecutionStatus,
  computePlanStatus,
  sortDiscoveryPlans,
  toTimestampValue,
  toIsoTimestamp,
  pickLatestIsoTimestamp,
  normalizeString,
  truncateText,
  normalizeStringList,
  PLAN_STATUS_ORDER,
  type WebPlanRecord,
} from "../../src/always-on/web/DiscoveryPlanStatus.js";

const NEVER_ACTIVE = () => false;
const ALWAYS_ACTIVE = () => true;

function makePlan(overrides: Partial<WebPlanRecord> = {}): WebPlanRecord {
  return {
    id: "plan-1",
    title: "Test plan",
    createdAt: "2026-05-08T10:00:00.000Z",
    updatedAt: "2026-05-08T10:00:00.000Z",
    approvalMode: "auto",
    status: "ready",
    summary: "",
    rationale: "",
    dedupeKey: "plan-1",
    sourceDiscoverySessionId: "",
    executionSessionId: "",
    executionStartedAt: "",
    executionLastActivityAt: "",
    executionStatus: "",
    latestSummary: "",
    contextRefs: { workingDirectory: [], memory: [], existingPlans: [], cronJobs: [], recentChats: [] },
    planFilePath: "plans/plan-1.md",
    structureVersion: 1,
    ...overrides,
  };
}

// ---- computeExecutionStatus ------------------------------------------------

test("computeExecutionStatus returns empty for superseded plans", () => {
  const plan = makePlan({ status: "superseded" });
  assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), "");
});

test("computeExecutionStatus returns running when session is active", () => {
  const plan = makePlan({ executionSessionId: "sess-1" });
  assert.equal(computeExecutionStatus(plan, null, (id) => id === "sess-1"), "running");
});

test("computeExecutionStatus returns failed when executionStatus is failed", () => {
  const plan = makePlan({ executionStatus: "failed" });
  assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), "failed");
});

test("computeExecutionStatus returns completed when executionStatus is completed", () => {
  const plan = makePlan({ executionStatus: "completed" });
  assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), "completed");
});

test("computeExecutionStatus upgrades queued to completed when session exists", () => {
  const plan = makePlan({ executionStatus: "queued", executionSessionId: "sess-1" });
  const session = { id: "sess-1" };
  assert.equal(computeExecutionStatus(plan, session, NEVER_ACTIVE), "completed");
});

test("computeExecutionStatus keeps queued when no session", () => {
  const plan = makePlan({ executionStatus: "queued" });
  assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), "queued");
});

test("computeExecutionStatus falls through to plan.status for known statuses", () => {
  for (const status of ["queued", "running", "completed", "failed"]) {
    const plan = makePlan({ status });
    assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), status);
  }
});

test("computeExecutionStatus returns empty for unknown status and no session", () => {
  const plan = makePlan({ status: "ready" });
  assert.equal(computeExecutionStatus(plan, null, NEVER_ACTIVE), "");
});

// ---- computePlanStatus -----------------------------------------------------

test("computePlanStatus returns superseded for superseded plans", () => {
  const plan = makePlan({ status: "superseded" });
  assert.equal(computePlanStatus(plan, null, NEVER_ACTIVE), "superseded");
});

test("computePlanStatus delegates to executionStatus when non-empty", () => {
  const plan = makePlan({ executionStatus: "running" });
  assert.equal(computePlanStatus(plan, null, NEVER_ACTIVE), "running");
});

test("computePlanStatus defaults to ready when nothing matches", () => {
  const plan = makePlan({ status: "" });
  assert.equal(computePlanStatus(plan, null, NEVER_ACTIVE), "ready");
});

// ---- sortDiscoveryPlans ----------------------------------------------------

test("sortDiscoveryPlans sorts by status priority then updatedAt descending", () => {
  const plans = [
    { status: "completed", updatedAt: "2026-05-08T09:00:00Z" },
    { status: "running", updatedAt: "2026-05-08T08:00:00Z" },
    { status: "ready", updatedAt: "2026-05-08T12:00:00Z" },
    { status: "ready", updatedAt: "2026-05-08T10:00:00Z" },
  ];
  const sorted = sortDiscoveryPlans(plans);
  assert.equal(sorted[0]!.status, "running");
  assert.equal(sorted[1]!.status, "ready");
  assert.ok(sorted[1]!.updatedAt! > sorted[2]!.updatedAt!);
  assert.equal(sorted[3]!.status, "completed");
});

// ---- utility helpers -------------------------------------------------------

test("toTimestampValue returns null for falsy", () => {
  assert.equal(toTimestampValue(null), null);
  assert.equal(toTimestampValue(undefined), null);
  assert.equal(toTimestampValue(""), null);
});

test("toTimestampValue parses ISO dates", () => {
  assert.equal(toTimestampValue("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z").getTime());
});

test("toIsoTimestamp round-trips", () => {
  const iso = "2026-05-08T10:00:00.000Z";
  assert.equal(toIsoTimestamp(iso), iso);
  assert.equal(toIsoTimestamp(null), "");
});

test("pickLatestIsoTimestamp picks the latest", () => {
  const a = "2026-05-08T10:00:00Z";
  const b = "2026-05-09T10:00:00Z";
  assert.equal(pickLatestIsoTimestamp(a, b), new Date(b).toISOString());
  assert.equal(pickLatestIsoTimestamp(null, undefined), "");
});

test("normalizeString trims and uses fallback", () => {
  assert.equal(normalizeString("  hello  "), "hello");
  assert.equal(normalizeString("", "fb"), "fb");
  assert.equal(normalizeString(null, "fb"), "fb");
});

test("truncateText truncates long strings", () => {
  const long = "a".repeat(300);
  const result = truncateText(long, 100);
  assert.equal(result.length, 100);
  assert.ok(result.endsWith("..."));
});

test("normalizeStringList filters non-strings", () => {
  assert.deepEqual(normalizeStringList(["a", "", "  b  ", 42, null]), ["a", "b"]);
  assert.deepEqual(normalizeStringList("not-array"), []);
});
