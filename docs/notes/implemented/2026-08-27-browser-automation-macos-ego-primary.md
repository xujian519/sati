# Agent Note: Browser automation — macOS uses ego lite as primary; other platforms keep current backends

Status: implemented

## Problem

The project carries four browser backends — `ego` (ego lite), `browseros-neo`, `browser-use`, `playwright` —
with a cascade router in `src/browser/backend/`. But the tool-execution layer (`ego_browser`,
`patent_pdf_download`) is hard-wired to `EgoBrowserSession` and gated to darwin, so the cascade is only
wired into the `sati browsers` probe command, not into actual browser execution.

A prior plan (`docs/windows-browser-automation-plan.md`) proposed converging on a unified cross-platform
cascade (ego → BrowserOS neo → browser-use → playwright), including wiring execution into the cascade
(Track A/B), a backend-agnostic SKILL intent layer, and auto-fallback on macOS when ego is unavailable.
The driver for that convergence was the premise that **ego lite now supports Windows**, which would make
"ego primary + browser-use fallback" a defensible two-layer convergence.

Verification (2026-08-27) shows that premise is false: ego lite's **desktop App is macOS-only**. Upstream
README states "runs on macOS today. Windows and Linux are on the roadmap"; the official roadmap lists
"Windows and Linux support" as **Planned** (not shipped); install scripts and download links are macOS
only. The `ego-browser` CLI (`package/ego-browser`, MIT) is cross-platform Node code, but it depends on the
**ego lite App process injecting `globalThis.ego`** as the CDP runtime (`browser-runtime.ts`:
`isBrowserRuntime()` checks `globalThis.ego.sendCDPMessage`), so without the App it throws
`browser runtime is not available`. "ego crosses platforms" therefore depends on the **App**, not the CLI.

## Decision

Since ego lite's desktop App remains macOS-only, fix the browser-automation strategy as:

1. **macOS: ego lite is the primary backend** — `ego_browser` / `patent_pdf_download` keep connecting
   directly to `EgoBrowserSession` (darwin gate unchanged); `sati browsers` cascade keeps ego first.
2. **Other platforms (Windows / Linux): keep current behavior unchanged** — the existing three backends
   (`browseros-neo` / `browser-use` / `@playwright/mcp`) stay as MCP-plugin surfaces plus `sati browsers`
   probing. No "unified convergence" work.
3. **This round does not push** execution-layer wiring into `resolveBrowserBackend()` auto-fallback
   (Track A/B), the SKILL backend-agnostic intent layer, `browser.preferredBackend` config, three-platform
   dry-run / CI matrix. These remain future options, not current commitments.

**Trigger for further convergence: only after ego lite ships a Windows release.** Record that re-evaluation
in a NEW note (per `docs/notes/README.md` rule 2); do not edit this one.

## Alternatives considered

- **Wire execution into `resolveBrowserBackend()` for auto-cascade so macOS also falls back when ego is
  unavailable** — rejected: this round keeps "other platforms unchanged", and auto-cascade needs Track B
  (a Node-side re-implementation of the ego-helper DSL bridged to browser-use/playwright), which plan
  review §S2 judged to be equivalent to re-writing a browser-driver library — high cost, uncertain current
  benefit. Re-evaluate once Windows ships.
- **Aggressively converge to a two-layer stack (ego + browser-use), dropping `browseros-neo` and
  `@playwright/mcp`** — rejected: it loses Windows Chrome-login import + screencast replay
  (browseros-neo, valuable for patent evidence) and the **zero-install fallback** (`@playwright/mcp`;
  browser-use needs Python ≥3.11 + uv + a fetched Chromium, which may be blocked on corporate Windows).
  Also "ego primary" simply does not hold on Windows (the App is not released), so the effective result
  would be "non-macOS relies on browser-use alone".
- **Fork `citrolabs/ego-lite` to add Windows support** — rejected: the public repo contains only the
  `ego-browser` CLI driver shell (MIT); the value-bearing ego lite **App** (task spaces, login-state
  inheritance, kernel-level snapshot) is **not in the public repo** and ships via DMG, so forking cannot
  deliver Windows capability. Cost = tracking a fork for no cross-platform gain; upstream already lists
  Windows on its roadmap, so "follow upstream + submit a feature request" dominates.
- **Chosen: keep the status quo** — macOS = ego primary (cascade already ranks ego first; execution was
  already darwin-only); all other platforms keep the existing three backends. Further convergence is an
  explicit deferred item, gated on the upstream Windows release.

## Consequences

- Scope is now explicit: browser automation = macOS uses ego (`ego_browser` / `patent_pdf_download`
  through `EgoBrowserSession`); other platforms use MCP atomic tools + `sati browsers` probing. No new
  engineering cost this round.
- The already-landed `BrowserBackend` abstraction (four backends + `resolveBrowserBackend`, cold
  decision) stays as detection/router infrastructure (used by `sati browsers`); it is reusable for
  auto-cascade once Windows support lands, without redoing the probe layer.
- Cost: on macOS, if ego is unavailable (not installed / hung / blocked by enterprise policy), the agent
  gets no browser and only the install-guidance hints — there is no automatic switch. Cross-platform
  "one script drives every backend" is not available now. This is acceptable given ego's macOS-only reach.
- The `docs/windows-browser-automation-plan.md` doc (§0) and the plan's §7.2/§7.3/§8/§10.5 are annotated
  as superseded/deferred, pointing back to this note.
