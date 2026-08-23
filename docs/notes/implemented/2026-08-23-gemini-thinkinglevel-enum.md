# Agent Note: Map local thinking level strings to Gemini ThinkingLevel enum

Status: implemented

## Problem

The Google provider built `thinkingConfig` for Gemini 2.5 models by threading the local
`ThinkingPlan.thinkingLevel` field straight into the SDK request object using a double cast:

```ts
thinkingLevel: thinkingPlan.thinkingLevel,
} as unknown as GenerateContentConfig["thinkingConfig"];
```

`ThinkingPlan.thinkingLevel` is the local lowercase union `"low" | "medium" | "high"`
(`src/model/thinking/registry.ts`). The Google GenAI SDK's `ThinkingLevel` is an enum whose
runtime values are uppercase (`"LOW"`, `"MEDIUM"`, `"HIGH"`), so the request that actually went
over the wire carried lowercase strings. The double cast silently suppressed the type mismatch
instead of surfacing it, so the wrong casing shipped without a type error or a test failure.

## Decision

Replace the double cast with an explicit, type-checked mapping:

```ts
const GOOGLE_THINKING_LEVEL = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
} as const satisfies Record<"low" | "medium" | "high", ThinkingLevel>;

// ...
thinkingLevel: GOOGLE_THINKING_LEVEL[thinkingPlan.thinkingLevel],
```

The `satisfies` clause keeps the mapping exhaustive and fails compilation if a new local level is
added without a corresponding enum value. Runtime request casing is now the SDK's canonical
uppercase form, and the type system enforces the contract instead of `unknown` swallowing it.

## Alternatives considered

- **Keep the double cast** — rejected; it is what hid the bug. Any future casing change by the
  SDK would silently regress again.
- **`satisfies GenerateContentConfig["thinkingConfig"]` on the inline object** — rejected during
  implementation; TS rejected lowercase strings against the SDK's `ThinkingLevel` enum, which is
  exactly the mismatch that was being hidden. It converted a silent bug into an unavoidable type
  error but did not fix the wire value.
- **Widen the SDK type via an ambient declaration** — rejected; changes a third-party type's
  meaning for one call site and would let other call sites pass invalid casing too.
- **Chosen**: explicit `ThinkingLevel` mapping with `satisfies` exhaustiveness.

## Consequences

- Gemini 2.5 requests now send `thinkingLevel: "LOW"/"MEDIUM"/"HIGH"` instead of the previous
  lowercase values; the request shape is now the SDK's canonical enum form.
- `GOOGLE_THINKING_LEVEL` is a module-local constant in `src/model/providers/google/request.ts`;
  the mapping is confined to the provider boundary rather than spread across model/streaming code.
- No tool `inputSchema` changed, so llm-replay fixtures remain valid; the affected test
  (`gemini-2.5-pro uses thinkingBudget`) still passes.
