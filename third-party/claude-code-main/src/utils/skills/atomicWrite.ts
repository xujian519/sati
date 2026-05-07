/**
 * Atomic write helper for skill files.
 *
 * Writes content to a sibling tmp file first, then renames over the target so
 * a crash mid-write never leaves half-written SKILL.md on disk. Mirrors
 * hermes-agent `tools/skill_manager_tool.py::_atomic_write_text`.
 *
 * Kept intentionally small — `fs.promises.rename` gives us the atomicity we
 * need; there's no need to duplicate the `O_EXCL|O_NOFOLLOW` dance used by
 * bundled-skill extraction (that guards against pre-existing symlinks in a
 * predictable cache dir; SKILL.md lives under user-controlled dirs where the
 * invariants are different).
 */

import { randomBytes } from 'node:crypto'
import {
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export async function atomicWriteFile(
  filePath: string,
  content: string,
): Promise<void> {
  const dir = dirname(filePath)
  await mkdir(dir, { recursive: true })

  const nonce = randomBytes(8).toString('hex')
  const tmpPath = join(dir, `.${basenameOf(filePath)}.tmp.${nonce}`)

  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8' })
    await rename(tmpPath, filePath)
  } catch (e) {
    // Best-effort cleanup; ignore failures since the rename was the critical step.
    try {
      await unlink(tmpPath)
    } catch {
      /* ignore */
    }
    throw e
  }
}

function basenameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return idx === -1 ? p : p.slice(idx + 1)
}
