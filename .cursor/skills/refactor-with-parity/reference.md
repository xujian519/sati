# Refactor With Parity Reference

## Refactor Document Template

Use this outline for a module refactor document:

Before drafting, inspect:

- `docs/rewrite-plan/02-rewrite-project-report.md`
- Any module-specific docs under `docs/`
- Current implementation under `src/`
- Legacy implementation under `third-party/claude-code-main/`
- Existing tests under `tests/`

```markdown
# <Module> Refactor Development Guide

## Goals
- What behavior must be preserved.
- What architecture changes are intended.
- What is explicitly out of scope.

## Legacy Inventory
| Legacy feature | Legacy entrypoint | New feature | Status | Notes |
| --- | --- | --- | --- | --- |

## Target Structure
```text
src/<module>/
  protocol/
  registry/
  execution/
  builtin/
  index.ts
```

## Public Protocol
- Types.
- Error codes.
- Result shape.
- Config keys.
- Audit/event shape.

## Execution Flow
```text
input
  -> parse/validate
  -> policy/permission
  -> execute
  -> normalize result
  -> audit
```

## Feature Matrix
| Legacy name | New name | First phase | Status | Reason |
| --- | --- | --- | --- | --- |

## Test Plan
- Unit tests.
- Contract parity.
- Execution parity.
- Deferred tests.
```

## Document Iteration Loop

Use this loop before implementation:

```text
draft refactor doc
  -> compare against rewrite-plan and current source
  -> compare against legacy source
  -> patch missing feature / wrong name / wrong phase
  -> repeat

draft test maintenance doc
  -> compare against refactor doc
  -> compare against legacy source and existing tests
  -> patch missing parity gate / scenario type / difference rule
  -> repeat
```

Do not treat documentation as a one-shot artifact. In this workflow, the documents are part of the refactor design and must be modified multiple times as source comparison reveals gaps.

## Test Maintenance Template

```markdown
# <Module> Test Maintenance Guide

## Test Layers
- Protocol tests.
- Registry/config tests.
- Runtime tests.
- Builtin/adapter tests.
- Contract parity tests.
- Execution parity tests.

## Behavior Consistency Definition
- Same inputs produce same normalized outputs.
- Same invalid inputs produce same normalized errors.
- Same permission/safety inputs produce same decisions.
- Intentional differences are documented.

## Parity Gates
- Every legacy feature is classified.
- All `compare` scenarios pass.
- All `intentional_difference` scenarios have a reason and risk.
- All `deferred` scenarios have an owner/phase.
```

## Scenario Type Template

```ts
export type ParityStatus =
  | "compare"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type ParityScenario = {
  id: string;
  status: ParityStatus;
  legacy: {
    featureName: string;
    input: Record<string, unknown>;
  };
  current: {
    featureName: string;
    input: Record<string, unknown>;
  };
  reason?: string;
};
```

## Contract Scenario Template

Use contract parity for metadata-like behavior:

```ts
export type ContractScenario = ParityScenario & {
  compareFields: Array<
    | "name"
    | "schema"
    | "readOnly"
    | "concurrencySafe"
    | "destructive"
    | "openWorld"
    | "requiresInteraction"
  >;
};
```

Normalized report:

```ts
export type ContractReport = {
  id: string;
  status: ParityStatus;
  legacyFeatureName: string;
  currentFeatureName: string;
  values?: Record<string, unknown>;
  reason?: string;
};
```

## Execution Scenario Template

Use execution parity for real behavior:

```ts
export type ExecutionScenario = ParityScenario & {
  workspace?: Record<string, string | Buffer>;
  env?: Record<string, string>;
};
```

Normalized report:

```ts
export type ExecutionReport = {
  id: string;
  status: ParityStatus;
  legacyFeatureName: string;
  currentFeatureName: string;
  result?: {
    status: "success" | "error";
    text?: string;
    errorCode?: string;
    data?: Record<string, unknown>;
  };
  reason?: string;
};
```

## Dual Diff Test Template

```ts
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createCurrentReport } from "../helpers/currentReport.js";

test("legacy and current reports match for compare scenarios", async () => {
  const legacyJson = execFileSync("bun", ["run", "legacy-report.ts"], {
    cwd: "legacy-source",
    encoding: "utf8",
  });
  const legacyReport = JSON.parse(legacyJson);
  const currentReport = await createCurrentReport();

  assert.deepEqual(
    currentReport.map(({ id, status }) => ({ id, status })),
    legacyReport.map(({ id, status }) => ({ id, status })),
  );

  const legacyById = new Map(legacyReport.map((item) => [item.id, item]));
  for (const item of currentReport) {
    const legacy = legacyById.get(item.id);
    assert.ok(legacy);
    if (item.status === "compare") {
      assert.deepEqual(item.result ?? item.values, legacy.result ?? legacy.values, item.id);
    }
  }
});
```

## Intentional Difference Register

```ts
export type IntentionalDifference = {
  id: string;
  legacyBehavior: string;
  currentBehavior: string;
  reason: string;
  risk: "lower" | "same" | "higher";
  reviewRequiredBeforeRelease: boolean;
};
```

Rules:

- `higher` risk always requires explicit review.
- Safety boundaries should never become weaker without review.
- Deferred work is not an intentional difference.

## Common Pitfalls

- Testing old and new code with similar but separate assertions instead of one shared scenario.
- Saying “parity passed” when only contract fields were compared.
- Letting legacy imports pull an entire vendored app instead of focused probes.
- Comparing raw outputs with absolute paths, timestamps, durations, or random ids.
- Marking hard behavior as deferred without a phase/reason.
- Normalizing away success vs error differences.

## Example From Tool Refactor

The tool refactor used two separate documents:

- `docs/politdeck-tool-refactor-development-guide.md`
- `docs/politdeck-tool-test-maintenance-guide.md`

The refactor document was revised after repeated checks against:

- `third-party/claude-code-main/src/tools.ts`
- `third-party/claude-code-main/src/Tool.ts`
- `third-party/claude-code-main/src/services/tools/toolExecution.ts`
- `third-party/claude-code-main/src/utils/permissions/permissions.ts`
- `third-party/claude-code-main/src/tools/*`

The test document was revised after realizing that ordinary parity scenarios were not enough; it needed:

- shared scenarios,
- old runner,
- new runner,
- normalized JSON reports,
- root diff tests,
- intentional difference register,
- deferred gates.

Contract parity compared:

- `Read` vs `read_file`: read-only and concurrency-safe flags.
- `Glob` vs `glob`: read-only and concurrency-safe flags.
- `Bash` vs `bash`: command read-only classification.

Execution parity compared:

- `Read` vs `read_file`: reads the same text file.
- `Glob` vs `glob`: matches the same TypeScript file in a temp workspace.
- `Bash` vs `bash`: `printf hello`.
- `Bash` vs `bash`: `sh -c 'exit 2'` returns normalized error.

The execution tests found a real mismatch: new `bash` initially treated non-zero exit as success, while legacy raised a shell error. The new implementation was changed to match legacy behavior.
