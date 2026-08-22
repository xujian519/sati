# Wire check:skills into the lint gate (2026-08-23)

## Status

Implemented

## Problem

`docs/development-standards.md` declared `check:skills` as one of the five
domain gates "均挂 `pnpm lint`", but it was neither on the lint chain
(`package.json`) nor green: `scripts/validate-skills.mjs` exited 1 with two hard
failures (`skills/ego-browser` and `skills/patent-teams` missing `SKILL.md`) and
17 warnings (patent/legal skills lacking knowledge-system wiring). The normative
spec therefore contradicted the enforced config, violating the standards' own
"docs must match enforcement" principle.

## Decision

Wire `check:skills` into the lint chain and make it genuinely green (exit 0).

## Alternatives considered

- **Only correct the docs (mark check:skills as not wired / red)**: rejected; the
  user preferred making the gate real over weakening the claim.
- **Make warnings non-blocking (exit 0 on warn-only)**: rejected; leaves 17
  advisories open and a less rigorous baseline.
- **Exempt the 17 patent/legal skills from knowledge wiring**: rejected; the
  warnings are semantically valid (these roles should consult the knowledge
  system).
- **Wire the skills + fix the hard failures**: chosen.

## Consequences

- `package.json` lint chain now ends with `&& pnpm check:skills` (5 domain gates
  as documented). `pnpm lint` / `pnpm check` now enforce skill validity.
- Added `SKILL.md` to `skills/ego-browser` and `skills/patent-teams` (fixes the
  two hard failures).
- Added a knowledge-system capability note (`patent_wiki_search` /
  `patent_case_search` / `law_search`) to 17 patent/legal SKILL.md files
  (`patent-team-composition` + 16 `provision-*` roles) so they can verify law /
  case / patent knowledge instead of relying on memory.
- `check:skills` now exits 0 ("All skills valid").
