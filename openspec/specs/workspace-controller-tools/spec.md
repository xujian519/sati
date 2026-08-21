# workspace-controller-tools Specification

## Purpose
TBD - created by archiving change jspace-workspace-ledger. Update Purpose after archive.

## Requirements

### Requirement: workspace_note records and reports, never decides

The `workspace_note` tool SHALL validate and persist ledger edits, and SHALL report the resulting state back to the caller. It SHALL NOT choose a solution or block the agent's work.

#### Scenario: Valid note persists and reports state
- **WHEN** a note contains a valid ledger edit
- **THEN** the ledger is updated and the new state is returned.

### Requirement: workspace_note refuses malformed writes

The `workspace_note` tool SHALL reject any write that would leave the ledger malformed (missing Goal/Next on open, empty `Next`, `Verified` without coverage, `Open` without settle-by, close without a checkpoint, core beyond two live).

#### Scenario: Malformed write is refused
- **WHEN** a note would create a malformed ledger
- **THEN** the tool returns a structured error and does not persist the malformed entry.

### Requirement: workspace_note does not drop independent edits

When a single note call contains both valid and invalid edits, the valid edits SHALL still be applied and reported, while the invalid ones are reported as rejected.

#### Scenario: Mixed note applies valid edits
- **WHEN** a note call updates the Goal and also contains an invalid core write
- **THEN** the Goal change is persisted and the invalid core write is reported as rejected.

### Requirement: workspace_ship is report-only

The `workspace_ship` tool SHALL inspect outgoing text for register leakage and failure signatures and SHALL report findings. It SHALL NOT block delivery: it returns a non-error result whether or not it finds anything.

#### Scenario: Ship reports findings without blocking
- **WHEN** the inspected text contains dense-track symbols or an uncovered "verified" claim
- **THEN** the tool reports those findings and still completes successfully.

#### Scenario: Ship reports clean when nothing is found
- **WHEN** the inspected text is clean
- **THEN** the tool reports clean and completes successfully.

### Requirement: workspace_ship detects specific leakage classes

The `workspace_ship` tool SHALL detect, at minimum: inner-register dense-track symbols in prose, state markers in outgoing text, "verified/confirmed" claims that do not state what the verification covered, and repetition loops (repeated lines or a character run).

#### Scenario: Dense-track symbols are detected
- **WHEN** the inspected text contains an inner-register symbol such as `⇒`, `⟸`, or `💀` outside fenced code
- **THEN** the tool reports the leak.

#### Scenario: Repetition loop is detected
- **WHEN** a line repeats three or more times, or a character runs 20 or more times
- **THEN** the tool reports the loop.

#### Scenario: Fenced code is not treated as prose
- **WHEN** the dense-track symbol appears inside a fenced code block
- **THEN** the tool does not report it as register leakage.
