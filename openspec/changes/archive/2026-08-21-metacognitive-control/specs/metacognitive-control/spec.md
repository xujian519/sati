## ADDED Requirements

### Requirement: Metacognitive prompt is injected when enabled

When enabled, the loop SHALL append a metacognitive prompt instructing the model to tag its confidence (`[confidence: strong|thin|shaky]`) before finalizing an uncertain answer and to carry a one-clause diagnosis (`[diagnosis: ...]`) into any retry. It SHALL be off by default.

#### Scenario: Prompt injected when enabled
- **WHEN** the metacognitive control is enabled and a model request is prepared
- **THEN** the metacognitive prompt is present in the request's system prompt.

#### Scenario: No prompt when disabled
- **WHEN** metacognitive control is disabled
- **THEN** no metacognitive prompt is added and the request is unchanged.

### Requirement: Confidence tag is parsed

The loop SHALL parse a confidence tag from the final assistant text.

#### Scenario: Strong/thin/shaky are recognized
- **WHEN** the assistant text contains `[confidence: strong]`, `[confidence: thin]`, or `[confidence: shaky]`
- **THEN** the parser returns the corresponding tag.

#### Scenario: No tag returns undefined
- **WHEN** the assistant text contains no confidence tag
- **THEN** the parser returns undefined and the loop terminates normally.

### Requirement: A shaky estimate does not silently finish

When enabled, a `shaky` confidence tag at the finish path SHALL trigger one control exit instead of a silent completion: retry-with-diagnosis, externalize the weak step, or escalate.

#### Scenario: Shaky triggers a retry carrying the diagnosis
- **WHEN** the finish path sees `[confidence: shaky]` with a `[diagnosis: ...]` and a metacognitive retry has not been attempted
- **THEN** the loop injects a transient retry prompt that carries the diagnosis and continues the turn, not a blank retry.

#### Scenario: Shaky does not loop indefinitely
- **WHEN** the finish path sees `[confidence: shaky]` again after a metacognitive retry
- **THEN** the loop does not retry again and terminates normally.

### Requirement: Retry carries the diagnosis

A metacognitive retry SHALL embed the model's own diagnosis rather than a fixed prompt.

#### Scenario: Diagnosis is embedded in the retry prompt
- **WHEN** a metacognitive retry is issued with a diagnosis
- **THEN** the retry prompt contains that diagnosis.
