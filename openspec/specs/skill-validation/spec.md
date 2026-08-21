# skill-validation Specification

## Purpose
TBD - created by archiving change jspace-workspace-ledger. Update Purpose after archive.

## Requirements

### Requirement: Role frontmatter is consistent

A skill declaring `type: role` SHALL carry a `domains` array and a `tools` array (or `"*"`); when present, `omitTools` SHALL be an array, `readOnly` SHALL be a boolean, and `systemPrompt` SHALL be a string.

#### Scenario: Role without domains is reported
- **WHEN** a skill has `type: role` but `domains` is missing or not an array
- **THEN** the validator reports a hard failure.

#### Scenario: Role without tools is reported
- **WHEN** a skill has `type: role` but `tools` is neither an array nor `"*"`
- **THEN** the validator reports a hard failure.

#### Scenario: Role with mis-typed optional fields is reported
- **WHEN** a role's `omitTools` is not an array, `readOnly` is not a boolean, or `systemPrompt` is not a string
- **THEN** the validator reports a hard failure.

### Requirement: No version-talk in skill text

The validator SHALL flag clear version-marketing phrases in SKILL.md text (for example `now adds`, `newly added`, `this release`, `upgraded from`), while not flagging legitimate third-party version numbers or category names.

#### Scenario: Marketing version talk is flagged
- **WHEN** a SKILL.md contains a clear version-marketing phrase
- **THEN** the validator reports it.

#### Scenario: Legitimate version reference is not flagged
- **WHEN** a SKILL.md mentions a third-party tool version (e.g. `v1.2.6`) or the word `changelog` as a category
- **THEN** the validator does not report it.

### Requirement: Same-family roles are not unstructured

For a patent-family role, the validator SHALL report a warning when the skill has neither structured `## ` body sections nor a substantive `systemPrompt`.

#### Scenario: Family role that is completely unstructured is reported
- **WHEN** a patent-family role has no `## ` section headings and no substantive `systemPrompt`
- **THEN** the validator reports a warning.

#### Scenario: Family role structured via systemPrompt is not reported
- **WHEN** a patent-family role carries its workflow in a substantive `systemPrompt` (even without `## ` body sections)
- **THEN** the validator does not report it.
