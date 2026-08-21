## Context

Sati already injects reasoning methodologies via `methodologyInjection` (a trigger-gated registry). This change adds a "bridge-before-conclusion + re-encode" component to that registry. It is a pure prompt template, no LLM call, matching the existing component contract.

## Goals / Non-Goals

**Goals:**
- A trigger-gated methodology component that asks the model to re-encode the requirement and let the intermediate form first.
- Registered in the default component set so it is available without extra config.

**Non-Goals:**
- Do not add a new config knob — reuse the existing methodology-injection path.
- Do not change the model's reasoning beyond the injected prompt.
- Off by default in the sense that it only fires on matching trigger keywords (like other methodology components).

## Decisions

### D1. One component covering both behaviors
`bridge-reencode` carries both the re-encode and bridge-before-conclusion instructions, since they are one cheap prompt-level discipline.

### D2. Trigger-gated via keywordScore
`identify` uses the shared `keywordScore` helper on reasoning/analysis triggers, so it only fires on relevant tasks and does not add noise to ordinary conversation.

### D3. Register in the default set
Adding it to `DEFAULT_METHODOLOGY_COMPONENTS` makes it available automatically; the registry already filters by `minScore`.

## Risks / Trade-offs

- **Prompt noise**: trigger-gated, so it only fires on matching tasks; the existing `injectMethodology` uses `minScore: 0.2` to avoid everyday conversation being forced into a template.
- **Behavioral effect is prompt-level**: depends on model compliance; no deterministic guarantee. Acceptable for a prompt-level methodology component.
