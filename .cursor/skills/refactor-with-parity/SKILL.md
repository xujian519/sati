---
name: refactor-with-parity
description: Plan and execute module refactors while proving behavior parity against legacy code. Use when refactoring a subsystem, replacing old code with new architecture, migrating tools/runtime/config/model/session modules, or when the user asks to ensure new and old behavior match.
---

# Refactor With Parity

Use this skill when a refactor must preserve behavior. The goal is not only to implement the new module, but to prove which behavior matches, which intentionally differs, and which is deferred.

## Core Rule

Do not claim “behavior is consistent with the old implementation” unless there is a shared scenario suite that runs both old and new code and compares normalized outputs.

## Source Of Truth

When writing a refactor development document in this repository, always read and use:

- `docs/rewrite-plan/02-rewrite-project-report.md`
- Existing module docs under `docs/`
- The current implementation source under `src/`
- The relevant legacy source under `third-party/claude-code-main/`
- Existing tests under `tests/`

Do not write a refactor plan from memory. The plan must cite the actual current source shape, legacy behavior, and existing test conventions.

Use precise wording:

- “Contract parity passed” means metadata/flags/schema-level behavior matched.
- “Execution parity passed” means both old and new code executed the same scenario and normalized outputs matched.
- “Deferred” means old behavior is recognized but not implemented yet.
- “Intentional difference” means new behavior differs by design and has a documented reason.

## Workflow

1. **Read source of truth first**
   - Read `docs/rewrite-plan/02-rewrite-project-report.md`.
   - Read relevant module docs under `docs/`.
   - Read current source under `src/`.
   - Read legacy source under `third-party/claude-code-main/`.
   - Read existing tests under `tests/`.

2. **Write the refactor development document**
   - Create a dedicated refactor document, e.g. `docs/<module>-refactor-development-guide.md`.
   - Define scope, target directories, public protocol, runtime flow, feature matrix, config, phases, and implementation order.
   - Classify each legacy feature as first-phase, skeleton, deferred, intentional difference, or not applicable.
   - Do not implement code yet unless the document is internally consistent.

3. **Review and modify the refactor document repeatedly**
   - Re-read legacy source and current source.
   - Compare the document against actual names, tools, modes, runtime paths, errors, and tests.
   - Patch the document when it misses a feature, misstates legacy behavior, or uses vague status.
   - Repeat until the document can guide implementation without guessing.

4. **Write the test maintenance / parity document**
   - Create a separate test document, e.g. `docs/<module>-test-maintenance-guide.md`.
   - Define unit test layers, parity scenario format, intentional difference register, deferred gates, and validation commands.
   - Define exactly when it is valid to say contract parity or execution parity passed.

5. **Review and modify the test document repeatedly**
   - Compare it against the refactor document and legacy source.
   - Add missing parity gates.
   - Add must-match, intentional-difference, deferred, and not-applicable rules.
   - Patch the test document until it can prevent false claims of parity.

6. **Inventory legacy behavior into test fixtures**
   - Locate old module entrypoints, public types, registries, execution paths, errors, config, tests, and feature flags.
   - Build a matrix of legacy feature → new feature → status.
   - Include hidden/dynamic features, aliases, deprecated names, and test-only tools.
   - Convert this matrix into scenario fixtures, not prose only.

7. **Implement in layers**
   - Protocol/types first.
   - Registry/config/parsing next.
   - Runtime/execution path next.
   - Builtins/adapters last.
   - Tests follow each layer.

8. **Build dual parity harness**
   - Shared scenarios live outside either implementation.
   - Legacy runner reads the shared scenario and outputs normalized JSON.
   - New runner reads the same scenario and outputs normalized JSON.
   - A root test compares the two reports for all `status: "compare"` scenarios.

9. **Run validation loop**
   - Run build.
   - Run new tests.
   - Run legacy probes if available.
   - Run dual parity diff.
   - Fix mismatches or reclassify with a documented reason.
   - Repeat until green.

10. **Update both documents after implementation**
   - If implementation changes behavior, update the refactor document.
   - If parity coverage changes, update the test maintenance document.
   - Do not leave docs behind the code.

## Status Classification

Every legacy feature must have one status:

- `compare`: old and new can run the same scenario; outputs must match.
- `intentional_difference`: behavior differs by design; include reason and risk.
- `deferred`: old behavior exists but new implementation is not ready.
- `not_applicable`: old behavior is product/test/internal-only and not migrated.

Never leave a feature unclassified.

## Dual Parity Pattern

Use this structure:

```text
tests/fixtures/<module>/dual-parity/
  contractScenarios.ts
  executionScenarios.ts

legacy-source/
  <module>-legacy-contract-report.ts
  <module>-legacy-execution-report.ts

tests/helpers/
  <module>ContractReport.ts
  <module>ExecutionReport.ts

tests/<module>/
  parity-dual-contract.test.ts
  parity-dual-execution.test.ts
```

The root parity tests should:

- Ensure scenario ids are unique.
- Ensure every non-compare scenario has a reason.
- Compare statuses between old and new reports.
- Deep-compare normalized report values for `compare` scenarios.

## Normalization Rules

Normalize away irrelevant differences:

- Absolute temp paths → workspace-relative paths.
- Timestamps → stable placeholders or omitted fields.
- Durations/PIDs/random ids → omitted or placeholders.
- Vendor-specific object shapes → canonical JSON.

Do not normalize away real behavior:

- Error vs success.
- Error code.
- Permission decision.
- Output text that the model would see.
- File edits and resulting content.
- Exit code semantics.

## Validation Commands

For this repository, use:

```bash
npm run build
npm test
```

If a legacy subtree uses Bun, also run the specific legacy probe:

```bash
bun test <legacy-probe.test.ts>
bun run <legacy-report.ts>
```

Avoid relying on a whole vendored project build if the vendored tree is incomplete. Prefer focused legacy probes that import the specific old behavior.

## References

For detailed templates and examples, read `reference.md`.
