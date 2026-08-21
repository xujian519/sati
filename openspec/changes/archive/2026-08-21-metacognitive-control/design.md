## Context

Sati has external circuit breakers (doomLoop, repeatToolReminder) that observe behavior, but no path that reads the model's own correctness estimate and turns it into a control decision. The metacognitive protocol from J-Space closes that gap: ask before/after, force an exit, make the retry carry the diagnosis.

## Goals / Non-Goals

**Goals:**
- A config-gated metacognitive prompt that asks the model to tag confidence and attach a diagnosis on retry.
- Parse the confidence tag; enforce one control exit on `shaky` instead of silently finishing.
- Retries carry the model's diagnosis.
- Off by default (no change to existing requests, so the llm-replay fixture is unaffected).

**Non-Goals:**
- Do not change the model's weights or training.
- Do not add a reconcile (run-two-and-compare) path in this change — the three-exit model is simplified to trust (default) + retry-with-diagnosis, with escalate/externalize reserved for the loop's existing error paths.
- Do not touch workspace-ledger.

## Decisions

### D1. Bracket-marked tags to avoid false positives
Confidence/diagnosis are bracketed (`[confidence: ...]`, `[diagnosis: ...]`) so the parser does not misfire on ordinary prose ("I'm not sure", "could be either").

### D2. Inject via system-prompt addendum
The metacognitive prompt is appended to the system prompt in `createModelRequest` (like the workspace-ledger addendum), gated by config. Off = no-op, so the replay fixture is unaffected.

### D3. Enforce only on `shaky`
`strong`/`thin` proceed (the tag may be surfaced as a status). Only `shaky` triggers a control exit, and only once per turn (guarded in `TurnRuntimeState`). This bounds the cost and avoids loops.

### D4. Retry carries the diagnosis
The retry uses `continueWithTransientPrompt` with a prompt that embeds the model's `[diagnosis: ...]` text, so it is not a blank retry.

## Risks / Trade-offs

- **Token cost / noise**: the prompt asks for tags only when relevant; tags are bracketed and parsed leniently. Mitigated by config gate (off by default).
- **Fragile parsing**: bracket markers reduce false positives; if the model does not emit a tag, the loop terminates normally (no behavior change).
- **Fixture compatibility**: off by default, so the recorded replay fixture's request keys are unchanged.
- **Scope**: deliberately limited to trust + retry-with-diagnosis; reconcile and escalate are deferred.
