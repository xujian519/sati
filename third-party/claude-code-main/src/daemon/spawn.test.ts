import { expect, test } from 'bun:test'
import { getDaemonCommandArgs, getDaemonWorkerCommandArgs } from './spawn.js'

test('source-mode daemon child processes preload runtime stubs', () => {
  const daemonArgs = getDaemonCommandArgs()
  expect(daemonArgs[0]).toBe('--preload')
  expect(daemonArgs[1]?.endsWith('/preload.ts')).toBe(true)
  expect(daemonArgs[2]).toBe('-e')
  expect(daemonArgs[3]).toContain('daemonMain')
  expect(daemonArgs[3]).toContain("daemonMain(['serve'])")

  const workerArgs = getDaemonWorkerCommandArgs('cron:/tmp/payload.json')
  expect(workerArgs[0]).toBe('--preload')
  expect(workerArgs[1]?.endsWith('/preload.ts')).toBe(true)
  expect(workerArgs[2]).toBe('-e')
  expect(workerArgs[3]).toContain('runDaemonWorker')
  expect(workerArgs[3]).toContain('"cron:/tmp/payload.json"')
})
