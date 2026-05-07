/**
 * Validation for SKILL.md content authored by the agent via SkillManage.
 *
 * Ported from hermes-agent `tools/skill_manager_tool.py::_validate_frontmatter`.
 * Enforces that:
 *   - The document starts with a `---` frontmatter block that parses as YAML.
 *   - `name` and `description` keys are present.
 *   - `description` stays within MAX_DESCRIPTION_LENGTH chars.
 *   - Body after frontmatter is non-empty.
 *   - Total content stays within MAX_SKILL_CONTENT_CHARS.
 */

import { parseYaml } from '../yaml.js'

export const MAX_SKILL_NAME_LENGTH = 64
export const MAX_SKILL_DESCRIPTION_LENGTH = 1024
// ~36k tokens at 2.75 chars/token. Matches hermes' MAX_SKILL_CONTENT_CHARS.
export const MAX_SKILL_CONTENT_CHARS = 100_000
export const MAX_SKILL_FILE_BYTES = 1_048_576 // 1 MiB per supporting file

// Filesystem-safe, URL-friendly skill names (matches hermes).
// Allow an optional leading category prefix ("category/name") — create action
// handles splitting separately; this regex validates a single segment.
export const VALID_SKILL_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/

/**
 * Validate a skill name segment. Returns error message or null if valid.
 */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Skill name is required.'
  if (name.length > MAX_SKILL_NAME_LENGTH) {
    return `Skill name exceeds ${MAX_SKILL_NAME_LENGTH} characters.`
  }
  if (!VALID_SKILL_NAME_RE.test(name)) {
    return (
      `Invalid skill name '${name}'. Use lowercase letters, numbers, ` +
      `hyphens, dots, and underscores. Must start with a letter or digit.`
    )
  }
  return null
}

export function validateSkillCategory(
  category: string | undefined,
): string | null {
  if (!category) return null
  const trimmed = category.trim()
  if (!trimmed) return null
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    return (
      `Invalid category '${category}'. Category must be a single directory name ` +
      `(no slashes).`
    )
  }
  return validateSkillName(trimmed)
}

/**
 * Validate the SKILL.md frontmatter. Returns error message or null if valid.
 */
export function validateSkillFrontmatter(content: string): string | null {
  if (!content.trim()) return 'Content cannot be empty.'
  if (!content.startsWith('---')) {
    return (
      "SKILL.md must start with YAML frontmatter ('---'). " +
      'See existing skills for the expected format.'
    )
  }

  // Find the closing '---' line. Search starts after the leading '---'.
  const endMatch = content.slice(3).match(/\n---\s*\n/)
  if (!endMatch || endMatch.index === undefined) {
    return "SKILL.md frontmatter is not closed. Add a closing '---' line."
  }

  const yamlContent = content.slice(3, 3 + endMatch.index)

  let parsed: unknown
  try {
    parsed = parseYaml(yamlContent)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return `YAML frontmatter parse error: ${msg}`
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Frontmatter must be a YAML mapping (key: value pairs).'
  }
  const fm = parsed as Record<string, unknown>

  if (!('name' in fm)) return "Frontmatter must include 'name' field."
  if (!('description' in fm)) {
    return "Frontmatter must include 'description' field."
  }
  const desc = fm.description
  if (desc != null && String(desc).length > MAX_SKILL_DESCRIPTION_LENGTH) {
    return `Description exceeds ${MAX_SKILL_DESCRIPTION_LENGTH} characters.`
  }

  const bodyStart = 3 + endMatch.index + endMatch[0].length
  const body = content.slice(bodyStart).trim()
  if (!body) {
    return (
      'SKILL.md must have content after the frontmatter (instructions, ' +
      'procedures, etc.).'
    )
  }

  return null
}

/**
 * Validate total content size. Returns error message or null if within bounds.
 */
export function validateSkillContentSize(
  content: string,
  label = 'SKILL.md',
): string | null {
  if (content.length > MAX_SKILL_CONTENT_CHARS) {
    return (
      `${label} content is ${content.length.toLocaleString()} characters ` +
      `(limit: ${MAX_SKILL_CONTENT_CHARS.toLocaleString()}). ` +
      `Split into a smaller SKILL.md with supporting files in references/ or templates/.`
    )
  }
  return null
}
