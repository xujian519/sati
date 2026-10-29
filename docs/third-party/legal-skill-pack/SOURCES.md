# Imported legal sources

- Upstream: https://github.com/CSlawyer1985/claude-for-legal-ZH
- Version: 1.1.0
- Commit: unknown (source checkout has no git metadata)
- Tree hash (SHA-256): 5177dcdd1cb7cc52a42b70b263bcb05c1e686f8dbad8db91ec2b62b29dc52a8d
- License: Apache License 2.0 (`LICENSE`, `NOTICE`)
- Imported skills: 124
- Regeneration: `LEGAL_ZH_ROOT=/path/to/claude-for-legal-ZH pnpm tsx scripts/import-legal-content.ts`
- Pin a checkout without git metadata: set `LEGAL_ZH_COMMIT=<sha>` for the same command.

The generated tree is committed; regenerate after changing the source or the
transforms in `scripts/import-legal-content.ts`.

## Supreme People's Court party-document styles

- Source: https://www.court.gov.cn/susong.html, branch "当事人参考民事诉讼文书样式"
- Forms: 105, published 2016-09-28
- Retrieved: 2026-10-26
- Location: `handwritten/legal-litigation-party-document-templates/references/styles/`
- Transcription: official body and 【说明】 copied from each detail page; no substantive edits.

These are official documents of a state organ, reproduced as a format reference;
they are not part of the Apache-licensed imported corpus above. The Civil
Procedure Law article numbers in a 2016 form are historical and must be checked
against current law before use.
