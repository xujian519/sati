import { describe, expect, test } from 'bun:test'
import { buildCronDaemonEnv } from './client.js'

describe('buildCronDaemonEnv', () => {
  test('opts daemon preload into CCR interceptor for sentinel base URL', () => {
    expect(
      buildCronDaemonEnv({
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:18080',
    })

    expect(
      buildCronDaemonEnv({
        ANTHROPIC_BASE_URL: 'http://ccr.local',
      }),
    ).toEqual({
      ANTHROPIC_BASE_URL: 'http://ccr.local',
      CCR_DAEMON_FETCH_INTERCEPTOR: '1',
    })
  })
})
