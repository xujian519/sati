# Changelog

All notable changes to `turnkey-cc-plugin` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Planned for 0.2.0
- Publish `.claude-plugin/marketplace.json` at repo root so
  `/plugin marketplace add Mingwwww/edgeclaw-opc` + `/plugin install turnkey@edgeclaw-opc`
  actually works.
- Update `plugin.json` metadata for public release: add `keywords`, finalize
  `author` / `repository`, drop the `-cc` pre-release suffix from `version`.
- Second full-funnel dogfood on a real (non-example) ticket.
- Align hook-event mapping table in `INSTALL.md` §5 with the stabilized Cursor
  `turnkey-prototype` `hooks.json`.

---

## [0.1.0] - 2026-04-21

First internal preview — Cursor `turnkey-prototype` ported to Claude Code plugin format.

### Added
- Plugin manifest at `.claude-plugin/plugin.json`.
- Nine skill directories under `skills/` mapped to `/turnkey:*` commands:
  `start`, `onboard`, `clarify`, `design`, `spec`, `tdd`, `develop`, `test`,
  `review`, `ship`.
- Claude Code hook bindings in `hooks/hooks.json` for `UserPromptSubmit`,
  `Stop`, and `PostToolUse`.
- Hook scripts:
  - `turnkey-capture.js` — writes session events to `~/.turnkey/inbox.jsonl`.
  - `turnkey-budget.js` — tracks context-budget level (green/yellow/orange/red).
  - `turnkey-stage-gate.js` — advisory gate between funnel stages.
  - `turnkey-substep-aggregator.js` — derives `develop` substep counts from
    `PostToolUse` capture.
  - `turnkey-bootstrap.js` — Phase-0 single-hook replacement for four
    parallel `Bash` tool calls (reduces upstream-proxy streaming fragility).
- `TURNKEY_HOME` env seam so hooks can run against a sandbox state dir.
- `examples/walkthrough.md` — illustrative full-funnel run.
- `INSTALL.md` §8 Obs-A contract: hook scripts must be non-blocking.

### Changed (vs. Cursor `turnkey-prototype`)
- Command namespace: `/turnkey-X` (Cursor) → `/turnkey:X` (Claude Code).
- Hook paths rewritten from `~/.cursor/hooks/...` to
  `${CLAUDE_PLUGIN_ROOT}/hooks/...`.
- Shares `~/.turnkey/` state dir with the Cursor prototype, by design
  (single-writer assumption, see `TROUBLESHOOTING-internal.md` §4).

### Removed
- `merge-hooks-json.js` (Cursor-specific merger) — Claude Code plugin loads
  its own `hooks.json` directly.

### Known limitations
- Marketplace distribution not yet published (see Unreleased).
- Some SKILL.md prose still references `turnkey-X` naming; invocation tables
  and the critical paths are already on `/turnkey:X`.
- First-run hook-event alignment between Cursor prototype and Claude Code
  port relies on manual review; automated contract test deferred.
