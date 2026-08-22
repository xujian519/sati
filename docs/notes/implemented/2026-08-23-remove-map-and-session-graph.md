# Remove map and session-graph features (2026-08-23)

## Status

Implemented

## Problem

The map (workspace/thread visualization, `src/map` + `ui/src/components/map`)
and session-graph (project session lineage, `ui/src/components/session-graph`)
features were merged to main but are not useful to the user and are removed. The
map feature had additionally been bundled into the development-standards PR by
mistake (scope creep on `chore/development-standards`) and shipped alongside it.

## Decision

Revert both features from main via `git revert`, keeping the development-standards
work intact.

## Alternatives considered

- **Keep map, only clean the branch**: rejected. `origin/main` already contains
  the map commits (merged via PR #140 as commits `f55623da3`/`bddc2dfc5`), so
  branch-level cleanup does not remove it from main; a main-level revert is
  required.
- **Keep session-graph**: rejected. It is a released, self-contained UI feature
  with no team integration (team sessions are excluded by `isInternalSession`),
  and the user does not use it.
- **Manual file deletion vs `git revert`**: chose `git revert` of the feature
  commits (`f55623da3`/`bddc2dfc5` for map; `79a23e36a`/`183cd146f`/`3bf5c3c90`
  for session-graph). Applied as a no-conflict chain.

## Consequences

- Map: `src/map/*`, `ui/src/components/map/*`, `ui/server/routes/map.js`,
  `tests/map/*`, map i18n namespace, and integration wiring removed. `/api/map/*`
  is no longer served; the map toggle and tab are gone.
- Session-graph: `ui/src/components/session-graph/*`, session-graph i18n
  namespace, and integration wiring removed; the Graph toggle and tab are gone.
- Team feature (`ui/src/components/team-panel/`) is unaffected (no coupling).
- `~/.sati/map/workspaces.json` becomes an orphaned runtime data file (not
  removed; user data).
