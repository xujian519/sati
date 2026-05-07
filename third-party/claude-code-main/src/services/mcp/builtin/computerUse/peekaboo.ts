import { execFile } from 'child_process'

export interface PeekabooResult {
  ok: boolean
  stdout: string
  stderr: string
  parsed?: unknown
}

let peekabooPath: string | null | undefined

/**
 * Check if peekaboo CLI is available on the system.
 */
export async function isPeekabooAvailable(): Promise<boolean> {
  if (peekabooPath !== undefined) return peekabooPath !== null
  peekabooPath = await findPeekaboo()
  return peekabooPath !== null
}

export function getPeekabooPath(): string | null {
  return peekabooPath ?? null
}

async function findPeekaboo(): Promise<string | null> {
  const candidates = [
    process.env.PEEKABOO_PATH,
    '/opt/homebrew/bin/peekaboo',
    '/usr/local/bin/peekaboo',
  ].filter(Boolean) as string[]

  for (const candidate of candidates) {
    try {
      const fs = await import('fs')
      if (fs.existsSync(candidate)) return candidate
    } catch { /* ignore */ }
  }

  // Try which
  try {
    const result = await runCommand('which', ['peekaboo'])
    if (result.ok && result.stdout.trim()) {
      return result.stdout.trim()
    }
  } catch { /* ignore */ }

  return null
}

function runCommand(cmd: string, args: string[]): Promise<PeekabooResult> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30000 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
      })
    })
  })
}

/**
 * Run a peekaboo command with --json flag, returning parsed JSON output.
 */
export async function runPeekaboo(
  subcommand: string,
  args: string[] = [],
): Promise<PeekabooResult> {
  const bin = getPeekabooPath()
  if (!bin) {
    return {
      ok: false,
      stdout: '',
      stderr: 'peekaboo is not installed. Install with: brew install steipete/tap/peekaboo',
    }
  }

  const fullArgs = [subcommand, '--json', ...args]
  const result = await runCommand(bin, fullArgs)

  if (result.ok && result.stdout.trim()) {
    try {
      result.parsed = JSON.parse(result.stdout)
    } catch {
      // Not JSON, leave as raw text
    }
  }

  return result
}

/**
 * Check if peekaboo has the necessary macOS permissions.
 */
export async function checkPermissions(): Promise<{
  screenRecording: boolean
  accessibility: boolean
}> {
  const result = await runPeekaboo('permissions')
  if (!result.ok || !result.parsed) {
    return { screenRecording: false, accessibility: false }
  }
  const data = result.parsed as Record<string, unknown>
  return {
    screenRecording: data.screenRecording === true || data.screen_recording === true,
    accessibility: data.accessibility === true,
  }
}
