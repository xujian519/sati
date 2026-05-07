#!/usr/bin/env bun
// Repro / regression check for the earlyInput escape-sequence parser.
// Run from claude-code-main:  bun scripts/early_input_repro.mjs

import { __testInternals, consumeEarlyInput } from '../src/utils/earlyInput.ts'

const cases = [
  ['Up arrow                ', '\x1b[A', ''],
  ['Down arrow              ', '\x1b[B', ''],
  ['Page Up                 ', '\x1b[5~', ''],
  ['Bracketed paste start   ', '\x1b[200~', ''],
  ['SS3 F1                  ', '\x1bOP', ''],
  ['Alt+B (META)            ', '\x1bb', ''],
  ['Lone ESC                ', '\x1b', ''],
  ['Mouse SGR press         ', '\x1b[<0;10;5M', ''],
  ['CSI u kitty             ', '\x1b[97;5u', ''],
  ['Focus in                ', '\x1b[I', ''],
  ['Focus out               ', '\x1b[O', ''],
  ['hi + Up + jk            ', 'hi\x1b[Ajk', 'hijk'],
  ['paste-wrapped "abc"     ', '\x1b[200~abc\x1b[201~', 'abc'],
  ['plain text              ', 'hello', 'hello'],
  ['CR converted to LF      ', '\r', '\n'],
]

const fmt = (s) =>
  [...s].map((c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ')

let failed = 0
for (const [label, input, expected] of cases) {
  __testInternals.reset()
  __testInternals.processChunk(input)
  const buf = __testInternals.buffer()
  const ok = buf === expected
  if (!ok) failed++
  console.log(
    `[${label}] in=[${fmt(input)}]  buffer=${JSON.stringify(buf)}  ${ok ? 'ok' : `FAIL (want ${JSON.stringify(expected)})`}`,
  )
  consumeEarlyInput() // clear
}

if (failed > 0) {
  console.error(`\n${failed} case(s) failed`)
  process.exit(1)
}
console.log('\nall ok')
