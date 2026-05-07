/**
 * Pure action handlers for SkillManageTool.
 *
 * Split out of SkillManageTool.ts so they can be unit-tested without touching
 * the full Tool harness (ToolUseContext, buildTool, etc.).  Each function is
 * side-effecting against the filesystem but does not depend on Claude Code
 * runtime state beyond `skillsDirResolver`.
 */

import { existsSync, readdirSync, statSync } from 'node:fs'
import { readFile, rm, rmdir, unlink } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { atomicWriteFile } from '../../utils/skills/atomicWrite.js'
import { fuzzyFindAndReplace } from '../../utils/skills/fuzzyMatch.js'
import {
  MAX_SKILL_FILE_BYTES,
  validateSkillCategory,
  validateSkillContentSize,
  validateSkillFrontmatter,
  validateSkillName,
} from '../../utils/skills/frontmatterValidate.js'
import {
  ALLOWED_SKILL_SUBDIRS,
  type SkillScope,
} from './constants.js'

export type SkillsDirResolver = (scope: SkillScope) => string

export type ActionInput = {
  name: string
  scope?: SkillScope
  category?: string
  content?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  file_path?: string
  file_content?: string
}

export type ActionResult = {
  success: boolean
  action: string
  name?: string
  path?: string
  message?: string
  error?: string
  matchCount?: number
  strategy?: string
  filePreview?: string
}

export type SkillLocation = {
  scope: SkillScope
  skillDir: string
}

// ---------------------------------------------------------------------------
// Path / lookup helpers
// ---------------------------------------------------------------------------

export function findExistingSkill(
  name: string,
  resolveDir: SkillsDirResolver,
): SkillLocation | null {
  const candidates: SkillScope[] = ['project', 'user']
  for (const scope of candidates) {
    const root = resolveDir(scope)
    const match = findSkillRecursive(root, name)
    if (match) return { scope, skillDir: match }
  }
  return null
}

function findSkillRecursive(root: string, name: string): string | null {
  if (!existsSync(root)) return null
  const direct = join(root, name)
  if (
    existsSync(direct) &&
    statSync(direct).isDirectory() &&
    existsSync(join(direct, 'SKILL.md'))
  ) {
    return direct
  }
  try {
    for (const entry of readdirSync(root)) {
      if (entry === '.git' || entry === '.hub') continue
      const candidate = join(root, entry, name)
      if (
        existsSync(candidate) &&
        statSync(candidate).isDirectory() &&
        existsSync(join(candidate, 'SKILL.md'))
      ) {
        return candidate
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

export function validateSupportingFilePath(filePath: string): string | null {
  if (!filePath) return 'file_path is required.'
  if (filePath.includes('..')) {
    return "Path traversal ('..') is not allowed."
  }
  if (filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath)) {
    return 'file_path must be relative to the skill directory.'
  }
  const parts = filePath.split(/[\\/]+/).filter(p => p.length > 0)
  if (parts.length < 2) {
    return (
      "Provide a file path, not just a directory. Example: 'references/api.md'."
    )
  }
  const head = parts[0]!
  if (
    !ALLOWED_SKILL_SUBDIRS.includes(
      head as (typeof ALLOWED_SKILL_SUBDIRS)[number],
    )
  ) {
    return (
      `File must be under one of: ${ALLOWED_SKILL_SUBDIRS.join(', ')}. ` +
      `Got: '${filePath}'`
    )
  }
  return null
}

export function resolveWithinSkillDir(
  skillDir: string,
  filePath: string,
): { target: string | null; error: string | null } {
  const target = resolve(skillDir, filePath)
  const rel = relative(skillDir, target)
  if (rel.startsWith('..') || rel === '' || resolve(skillDir, rel) !== target) {
    return {
      target: null,
      error: 'Resolved path escapes the skill directory.',
    }
  }
  return { target, error: null }
}

export function isWithinAnySkillsRoot(
  path: string,
  resolveDir: SkillsDirResolver,
): boolean {
  const abs = resolve(path)
  const userRoot = resolve(resolveDir('user')) + sep
  const projectRoot = resolve(resolveDir('project')) + sep
  return abs.startsWith(userRoot) || abs.startsWith(projectRoot)
}

function errOut(action: string, error: string, name?: string): ActionResult {
  return { success: false, action, name, error }
}

// ---------------------------------------------------------------------------
// Action handlers
// ---------------------------------------------------------------------------

export async function createSkill(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name, content, category } = input
  if (!content) return errOut('create', 'content is required for create.')

  const nameError = validateSkillName(name)
  if (nameError) return errOut('create', nameError, name)

  const categoryError = validateSkillCategory(category)
  if (categoryError) return errOut('create', categoryError, name)

  const fmError = validateSkillFrontmatter(content)
  if (fmError) return errOut('create', fmError, name)

  const sizeError = validateSkillContentSize(content)
  if (sizeError) return errOut('create', sizeError, name)

  if (findExistingSkill(name, resolveDir)) {
    return errOut('create', `A skill named '${name}' already exists.`, name)
  }

  const scope: SkillScope = input.scope ?? 'user'
  const root = resolveDir(scope)
  const trimmedCategory = category?.trim() || null
  const skillDir = trimmedCategory
    ? join(root, trimmedCategory, name)
    : join(root, name)
  const skillMd = join(skillDir, 'SKILL.md')

  await atomicWriteFile(skillMd, content)

  return {
    success: true,
    action: 'create',
    name,
    path: skillDir,
    message: `Skill '${name}' created at ${skillDir}.`,
  }
}

export async function editSkill(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name, content } = input
  if (!content) return errOut('edit', 'content is required for edit.', name)

  const fmError = validateSkillFrontmatter(content)
  if (fmError) return errOut('edit', fmError, name)

  const sizeError = validateSkillContentSize(content)
  if (sizeError) return errOut('edit', sizeError, name)

  const existing = findExistingSkill(name, resolveDir)
  if (!existing) return errOut('edit', `Skill '${name}' not found.`, name)

  const skillMd = join(existing.skillDir, 'SKILL.md')
  await atomicWriteFile(skillMd, content)

  return {
    success: true,
    action: 'edit',
    name,
    path: existing.skillDir,
    message: `Skill '${name}' updated.`,
  }
}

export async function patchSkill(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name, old_string, new_string, replace_all, file_path } = input
  if (!old_string) {
    return errOut('patch', 'old_string is required for patch.', name)
  }
  if (new_string === undefined) {
    return errOut(
      'patch',
      'new_string is required for patch. Use empty string to delete matched text.',
      name,
    )
  }

  const existing = findExistingSkill(name, resolveDir)
  if (!existing) return errOut('patch', `Skill '${name}' not found.`, name)
  const { skillDir } = existing

  let target: string
  let targetLabel: string
  if (file_path) {
    const pathError = validateSupportingFilePath(file_path)
    if (pathError) return errOut('patch', pathError, name)
    const { target: resolved, error } = resolveWithinSkillDir(
      skillDir,
      file_path,
    )
    if (error || !resolved) return errOut('patch', error!, name)
    target = resolved
    targetLabel = file_path
  } else {
    target = join(skillDir, 'SKILL.md')
    targetLabel = 'SKILL.md'
  }

  if (!existsSync(target)) {
    return errOut(
      'patch',
      `File not found: ${relative(skillDir, target)}`,
      name,
    )
  }

  const contents = await readFile(target, 'utf-8')
  const fuzzy = fuzzyFindAndReplace(
    contents,
    old_string,
    new_string,
    Boolean(replace_all),
  )
  if (fuzzy.error) {
    const preview = contents.slice(0, 500) + (contents.length > 500 ? '…' : '')
    return {
      success: false,
      action: 'patch',
      name,
      error: fuzzy.error,
      filePreview: preview,
    }
  }

  const sizeError = validateSkillContentSize(fuzzy.newContent, targetLabel)
  if (sizeError) return errOut('patch', sizeError, name)

  if (!file_path) {
    const fmError = validateSkillFrontmatter(fuzzy.newContent)
    if (fmError) {
      return errOut(
        'patch',
        `Patch would break SKILL.md structure: ${fmError}`,
        name,
      )
    }
  }

  await atomicWriteFile(target, fuzzy.newContent)

  return {
    success: true,
    action: 'patch',
    name,
    path: target,
    matchCount: fuzzy.matchCount,
    strategy: fuzzy.strategy ?? undefined,
    message:
      `Patched ${targetLabel} in skill '${name}' ` +
      `(${fuzzy.matchCount} replacement${fuzzy.matchCount > 1 ? 's' : ''}, ` +
      `strategy=${fuzzy.strategy}).`,
  }
}

export async function deleteSkill(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name } = input
  const existing = findExistingSkill(name, resolveDir)
  if (!existing) return errOut('delete', `Skill '${name}' not found.`, name)

  await rm(existing.skillDir, { recursive: true, force: true })

  // Prune empty category dir one level up.
  const root = resolveDir(existing.scope)
  const parent = resolve(existing.skillDir, '..')
  if (parent !== resolve(root)) {
    try {
      await rmdir(parent)
    } catch {
      /* ignore non-empty or missing */
    }
  }

  return {
    success: true,
    action: 'delete',
    name,
    message: `Skill '${name}' deleted.`,
  }
}

export async function writeSupportingFile(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name, file_path, file_content } = input
  if (!file_path) {
    return errOut('write_file', 'file_path is required for write_file.', name)
  }
  if (file_content === undefined) {
    return errOut(
      'write_file',
      'file_content is required for write_file.',
      name,
    )
  }
  const pathError = validateSupportingFilePath(file_path)
  if (pathError) return errOut('write_file', pathError, name)

  const byteLength = Buffer.byteLength(file_content, 'utf-8')
  if (byteLength > MAX_SKILL_FILE_BYTES) {
    return errOut(
      'write_file',
      `File content is ${byteLength.toLocaleString()} bytes ` +
        `(limit: ${MAX_SKILL_FILE_BYTES.toLocaleString()} / 1 MiB). ` +
        `Split into smaller files.`,
      name,
    )
  }
  const sizeError = validateSkillContentSize(file_content, file_path)
  if (sizeError) return errOut('write_file', sizeError, name)

  const existing = findExistingSkill(name, resolveDir)
  if (!existing) {
    return errOut(
      'write_file',
      `Skill '${name}' not found. Create it first with action='create'.`,
      name,
    )
  }
  const { target, error } = resolveWithinSkillDir(existing.skillDir, file_path)
  if (error || !target) return errOut('write_file', error!, name)

  await atomicWriteFile(target, file_content)

  return {
    success: true,
    action: 'write_file',
    name,
    path: target,
    message: `File '${file_path}' written to skill '${name}'.`,
  }
}

export async function removeSupportingFile(
  input: ActionInput,
  resolveDir: SkillsDirResolver,
): Promise<ActionResult> {
  const { name, file_path } = input
  if (!file_path) return errOut('remove_file', 'file_path is required.', name)

  const pathError = validateSupportingFilePath(file_path)
  if (pathError) return errOut('remove_file', pathError, name)

  const existing = findExistingSkill(name, resolveDir)
  if (!existing) {
    return errOut('remove_file', `Skill '${name}' not found.`, name)
  }

  const { target, error } = resolveWithinSkillDir(existing.skillDir, file_path)
  if (error || !target) return errOut('remove_file', error!, name)
  if (!existsSync(target)) {
    return errOut(
      'remove_file',
      `File '${file_path}' not found in skill '${name}'.`,
      name,
    )
  }

  await unlink(target)
  try {
    const parent = resolve(target, '..')
    if (parent !== resolve(existing.skillDir)) {
      await rmdir(parent)
    }
  } catch {
    /* ignore */
  }

  return {
    success: true,
    action: 'remove_file',
    name,
    message: `File '${file_path}' removed from skill '${name}'.`,
  }
}
