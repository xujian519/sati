import assert from "node:assert/strict";
import test from "node:test";
import { AlwaysOnError } from "../../src/always-on/protocol/errors.js";
import {
  parsePlanMarkdown,
  PLAN_REQUIRED_SECTIONS,
} from "../../src/always-on/contracts/PlanContract.js";

const VALID_PLAN = `# Improve build cache

> Always-On Discovery Plan
> id: plan_001
> sourceRunId: run_001
> createdAt: 2026-05-08T12:00:00Z
> projectRoot: /tmp/projects/sample
> dedupeKey: build-cache

## Summary
Enable npm cache to cut CI time roughly in half.

## Rationale
CI currently re-installs dependencies for every job because no cache is configured.

## Context Signals
- .github/workflows/ci.yml does not configure actions/cache
- package-lock.json present in repo root

## Proposed Change
Add an actions/cache@v4 step keyed on the lockfile so node_modules is reused between runs.

## Execution Steps
1. Edit .github/workflows/ci.yml to add cache step.
2. Push branch and rerun the CI workflow on the new commit.

## Verification
- "Cache restored" appears in the CI logs
- ci-time metric drops below previous baseline
`;

test("parsePlanMarkdown accepts a fully compliant plan and exposes metadata", () => {
  const parsed = parsePlanMarkdown(VALID_PLAN);
  assert.equal(parsed.title, "Improve build cache");
  assert.deepEqual(parsed.metadata, {
    id: "plan_001",
    sourceRunId: "run_001",
    createdAt: "2026-05-08T12:00:00Z",
    projectRoot: "/tmp/projects/sample",
    dedupeKey: "build-cache",
  });
  for (const section of PLAN_REQUIRED_SECTIONS) {
    assert.ok(parsed.sections[section], `expected section ${section}`);
  }
});

test("parsePlanMarkdown rejects a plan missing the metadata blockquote", () => {
  const broken = VALID_PLAN.replace("> Always-On Discovery Plan", "> Some other line");
  assert.throws(() => parsePlanMarkdown(broken), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});

test("parsePlanMarkdown rejects extra sections like Risks/Rollback", () => {
  const withRollback = `${VALID_PLAN}
## Rollback
Revert the workflow change.
`;
  assert.throws(() => parsePlanMarkdown(withRollback), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );

  const withRisks = `${VALID_PLAN}
## Risks
- cache poisoning
`;
  assert.throws(() => parsePlanMarkdown(withRisks), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});

test("parsePlanMarkdown rejects out-of-order sections", () => {
  const reordered = VALID_PLAN.replace(
    /## Rationale[\s\S]*?\n## Context Signals/,
    "## Context Signals",
  );
  assert.throws(() => parsePlanMarkdown(reordered), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});

test("parsePlanMarkdown rejects an Execution Steps section using bullets", () => {
  const broken = VALID_PLAN.replace(
    /## Execution Steps[\s\S]*?## Verification/,
    [
      "## Execution Steps",
      "- bullet not allowed",
      "- another bullet",
      "",
      "## Verification",
    ].join("\n"),
  );
  assert.throws(() => parsePlanMarkdown(broken), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});

test("parsePlanMarkdown rejects fuzzy Proposed Change body", () => {
  const broken = VALID_PLAN.replace(
    /## Proposed Change[\s\S]*?## Execution Steps/,
    [
      "## Proposed Change",
      "TODO: figure this out later.",
      "",
      "## Execution Steps",
    ].join("\n"),
  );
  assert.throws(() => parsePlanMarkdown(broken), (error) =>
    error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});

test("parsePlanMarkdown rejects an oversize plan", () => {
  const huge = VALID_PLAN + "\n" + "x".repeat(120_000);
  assert.throws(
    () => parsePlanMarkdown(huge, { maxResultSizeChars: 100_000 }),
    (error) => error instanceof AlwaysOnError && error.code === "plan_invalid",
  );
});
