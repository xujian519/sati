import { expect, test } from 'bun:test'
import { routeTurnkeySubcommand } from './turnkeySubcommandRouting.js'

test('routes /turnkey subcommands to canonical turnkey:* commands', () => {
  const routed = routeTurnkeySubcommand(
    'turnkey',
    'onboard phase-1',
    name => name === 'turnkey:onboard',
  )

  expect(routed).toEqual({
    commandName: 'turnkey:onboard',
    args: 'phase-1',
    routed: true,
  })
})

test('keeps original command when no matching turnkey subcommand exists', () => {
  const routed = routeTurnkeySubcommand('turnkey', 'unknown task', () => false)
  expect(routed).toEqual({
    commandName: 'turnkey',
    args: 'unknown task',
    routed: false,
  })
})

test('does not rewrite non-turnkey commands', () => {
  const routed = routeTurnkeySubcommand('ao', 'list', () => true)
  expect(routed).toEqual({
    commandName: 'ao',
    args: 'list',
    routed: false,
  })
})
