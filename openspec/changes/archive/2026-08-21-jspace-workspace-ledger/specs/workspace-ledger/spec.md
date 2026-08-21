## ADDED Requirements

### Requirement: Ledger has five ordered sections

The workspace ledger SHALL expose five sections in a fixed order: `Goal`, `Core`, `Verified`, `Open`, `Next`.

#### Scenario: Initial ledger is empty
- **WHEN** a session has not recorded any workspace state
- **THEN** the ledger resolves to an empty `Goal`, an empty `Core`, an empty `Verified`, an empty `Open`, and an empty `Next`.

#### Scenario: Sections render in fixed order
- **WHEN** a ledger is rendered into the model-visible `<workspace-state>` block
- **THEN** the sections appear in the order Goal, Core, Verified, Open, Next.

### Requirement: Goal and Next are required to open the ledger

A ledger SHALL only be created when both `Goal` and `Next` are provided; `Next` SHALL never be empty once a ledger is open.

#### Scenario: Opening without Goal or Next is refused
- **WHEN** a note sets only `Goal` or only `Next`, or neither, on an unopened ledger
- **THEN** the write is rejected and no ledger state is persisted.

#### Scenario: Next is never empty
- **WHEN** a note would leave `Next` unset on an open ledger
- **THEN** the write is rejected and the previous `Next` is preserved.

### Requirement: Verified entries are numbered and append-only

Every `Verified` entry SHALL carry a monotonically increasing number, be append-only, and include both the claim and what verified it (verifier plus coverage).

#### Scenario: Verified numbering is monotonic
- **WHEN** two checkpoints are recorded
- **THEN** the second gets a higher number than the first and neither is reused.

#### Scenario: Verified requires coverage
- **WHEN** a checkpoint is recorded without a verifier/coverage clause
- **THEN** the write is rejected.

### Requirement: Open entries are numbered and only close against a checkpoint

Every `Open` entry SHALL carry a number that is never reused after it closes; an `Open` entry SHALL only close against a recorded checkpoint.

#### Scenario: Open requires a settle-by test
- **WHEN** an open question is recorded without a `settledBy` test
- **THEN** the write is rejected.

#### Scenario: Open closes only against a recorded checkpoint
- **WHEN** a close references an open question but no checkpoint was recorded in the same call
- **THEN** the close is rejected and the open question remains.

#### Scenario: Closed open numbers are not reused
- **WHEN** an open question closes and a new open question is recorded
- **THEN** the new question receives a fresh number distinct from the closed one.

### Requirement: Core holds at most two live entries

The `Core` section SHALL hold at most two live entries; additional entries SHALL be parked, and replacing a live entry SHALL be an explicit swap.

#### Scenario: A third live core entry is refused
- **WHEN** a note adds a core entry beyond the two live slots without an explicit slot swap
- **THEN** the entry is parked rather than made live.

#### Scenario: Swapping requires an explicit slot
- **WHEN** a note replaces a live core entry
- **THEN** it targets an explicit live slot and the displaced entry moves to parked.

### Requirement: Ledger survives compaction

The ledger SHALL be re-derived from the transcript and re-injected before each model call, so it is not shadowed or lost when a compaction summary replaces earlier history.

#### Scenario: Ledger is present after compaction
- **WHEN** a compaction pass shadows earlier messages
- **THEN** the model-visible `<workspace-state>` block still contains the latest ledger.

#### Scenario: Ledger state is read fresh per call
- **WHEN** a model call is prepared
- **THEN** the injected ledger is the latest persisted state, not a copy from message history.
