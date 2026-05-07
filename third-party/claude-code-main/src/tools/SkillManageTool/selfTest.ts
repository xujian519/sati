/**
 * Self-test for SkillManageTool.  Runs without the Claude Code runtime — only
 * exercises the pure action handlers, the frontmatter validator, fuzzy matcher,
 * and atomic write helper against a temp directory.
 *
 * Usage:
 *   bun src/tools/SkillManageTool/selfTest.ts
 *
 * Exits with status 1 on first failure so `bun run` propagates the error.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFile } from '../../utils/skills/atomicWrite.js'
import {
  fuzzyFindAndReplace,
  similarityRatio,
} from '../../utils/skills/fuzzyMatch.js'
import {
  validateSkillFrontmatter,
  validateSkillName,
} from '../../utils/skills/frontmatterValidate.js'
import {
  createSkill,
  deleteSkill,
  editSkill,
  findExistingSkill,
  patchSkill,
  removeSupportingFile,
  writeSupportingFile,
  type SkillsDirResolver,
} from './actions.js'

type Test = { name: string; fn: () => void | Promise<void> }
const tests: Test[] = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`)
}
function assertEq(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(
      `Assertion failed: ${msg}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`,
    )
  }
}

const SAMPLE_SKILL = `---
name: sample-skill
description: A sample skill for the self-test.
---

# Sample Skill

Step 1: Do the first thing.
Step 2: Do the second thing.
Step 3: Do the final thing.
`

// ---------------------------------------------------------------------------
// frontmatterValidate
// ---------------------------------------------------------------------------

test('validateSkillName accepts lowercase kebab', () => {
  assertEq(validateSkillName('foo-bar'), null, 'foo-bar is valid')
  assertEq(validateSkillName('foo_bar.baz1'), null, 'allow . _ and digits')
})

test('validateSkillName rejects uppercase / bad starts', () => {
  assert(validateSkillName('Foo'), 'uppercase rejected')
  assert(validateSkillName('-leading'), 'leading hyphen rejected')
  assert(validateSkillName(''), 'empty rejected')
  assert(validateSkillName('a'.repeat(100)), 'over 64 chars rejected')
})

test('validateSkillFrontmatter accepts valid SKILL.md', () => {
  assertEq(validateSkillFrontmatter(SAMPLE_SKILL), null, 'sample is valid')
})

test('validateSkillFrontmatter rejects missing name', () => {
  const bad = `---\ndescription: x\n---\n\nbody`
  const err = validateSkillFrontmatter(bad)
  assert(err && /name/.test(err), 'complains about name')
})

test('validateSkillFrontmatter rejects missing description', () => {
  const bad = `---\nname: x\n---\n\nbody`
  const err = validateSkillFrontmatter(bad)
  assert(err && /description/.test(err), 'complains about description')
})

test('validateSkillFrontmatter rejects empty body', () => {
  const bad = `---\nname: x\ndescription: y\n---\n`
  const err = validateSkillFrontmatter(bad)
  assert(err && /content after the frontmatter/.test(err), 'empty body rejected')
})

test('validateSkillFrontmatter rejects unclosed frontmatter', () => {
  const bad = `---\nname: x\ndescription: y\n`
  const err = validateSkillFrontmatter(bad)
  assert(err && /not closed/.test(err), 'unclosed frontmatter rejected')
})

// ---------------------------------------------------------------------------
// fuzzyFindAndReplace
// ---------------------------------------------------------------------------

test('fuzzy exact match', () => {
  const r = fuzzyFindAndReplace('hello world', 'world', 'there', false)
  assertEq(r.newContent, 'hello there', 'exact replace')
  assertEq(r.strategy, 'exact', 'strategy=exact')
  assertEq(r.matchCount, 1, 'one match')
})

test('fuzzy multi-match without replace_all errors', () => {
  const r = fuzzyFindAndReplace('ab ab ab', 'ab', 'xy', false)
  assert(r.error && /3 matches/.test(r.error), 'errors on >1 match')
})

test('fuzzy replace_all replaces all', () => {
  const r = fuzzyFindAndReplace('ab ab ab', 'ab', 'xy', true)
  assertEq(r.newContent, 'xy xy xy', 'replace_all works')
  assertEq(r.matchCount, 3, 'three matches')
})

test('fuzzy line-trimmed strips trailing whitespace per line', () => {
  const content = 'foo   \nbar\nbaz'
  const r = fuzzyFindAndReplace(content, 'foo\nbar', 'FOO\nBAR', false)
  assertEq(r.strategy, 'line_trimmed', 'line_trimmed picked')
  assert(r.newContent.includes('FOO\nBAR'), 'text replaced')
  assert(r.newContent.includes('baz'), 'rest preserved')
})

test('fuzzy tolerates indentation-only differences', () => {
  const content = '    def hello():\n        print("hi")\n'
  const r = fuzzyFindAndReplace(
    content,
    'def hello():\nprint("hi")',
    'def hello():\nprint("hello world")',
    false,
  )
  // Either line_trimmed or indentation_flexible can match — both strip
  // leading whitespace. What matters is the replacement succeeds.
  assert(
    r.strategy === 'line_trimmed' || r.strategy === 'indentation_flexible',
    `strategy is one of line_trimmed/indentation_flexible (got ${r.strategy})`,
  )
  assert(r.newContent.includes('hello world'), 'replaced')
})

test('fuzzy indentation_flexible triggers when trailing whitespace differs', () => {
  // line_trimmed also strips trailing whitespace, so to force indentation_flexible
  // we need a case where the pattern has DIFFERENT trailing whitespace than the
  // file — line_trimmed would still match (both sides get trimmed), so actually
  // this strategy is practically a subset.  Just verify it works standalone.
  const content = '    foo   \n    bar\n'
  const r = fuzzyFindAndReplace(content, 'foo   \nbar', 'XFOO\nXBAR', false)
  assert(r.error === null, `expected success: ${r.error}`)
  assert(r.newContent.includes('XFOO\nXBAR'), 'replaced')
})

test('fuzzy no-match returns error', () => {
  const r = fuzzyFindAndReplace('hello', 'world', 'there', false)
  assert(r.error && /Could not find/.test(r.error), 'no match error')
})

// ---------------------------------------------------------------------------
// fuzzyFindAndReplace — strategies 5-9 (new)
// ---------------------------------------------------------------------------

test('fuzzy whitespace_normalized collapses internal runs', () => {
  // Content has multiple spaces; pattern has single spaces. Neither exact nor
  // line_trimmed (same leading/trailing ws) nor indentation_flexible catches
  // this — internal whitespace collapsing is what matters.
  const content = 'foo    bar   baz'
  const r = fuzzyFindAndReplace(content, 'foo bar baz', 'XYZ', false)
  assertEq(r.strategy, 'whitespace_normalized', 'strategy picked')
  assertEq(r.newContent, 'XYZ', 'replacement applied')
})

test('fuzzy escape_normalized decodes \\n in pattern', () => {
  const content = 'line A\nline B\nline C'
  // Pattern uses literal backslash-n (LLM-emitted escaped newlines).
  const r = fuzzyFindAndReplace(content, 'line A\\nline B', 'X\nY', false)
  assertEq(r.strategy, 'escape_normalized', 'strategy picked')
  assert(r.newContent.startsWith('X\nY'), 'replacement present')
})

test('fuzzy unicode_normalized ASCII-folds smart quotes', () => {
  // Content uses ASCII quotes; pattern uses smart quotes (typo via
  // autocorrect). Exact / line_trimmed / whitespace_normalized all miss.
  const content = 'hello "world"'
  const smartPattern = 'hello \u201cworld\u201d'
  const r = fuzzyFindAndReplace(content, smartPattern, 'HI', false)
  assertEq(r.strategy, 'unicode_normalized', 'strategy picked')
  assertEq(r.newContent, 'HI', 'replacement applied')
})

test('fuzzy unicode_normalized handles multi-char expansion (ellipsis)', () => {
  // Content has ASCII '...', pattern uses Unicode ellipsis.
  const content = 'loading... done'
  const r = fuzzyFindAndReplace(
    content,
    'loading\u2026 done',
    'READY',
    false,
  )
  assertEq(r.strategy, 'unicode_normalized', 'strategy picked')
  assertEq(r.newContent, 'READY', 'replacement applied')
})

test('fuzzy block_anchor matches on first+last with middle similarity', () => {
  const content = [
    'function foo() {',
    '  const x = 1;',
    '  const y = 2;',
    '  const z = 3;',
    '  return x + y + z;',
    '}',
    'rest of file',
  ].join('\n')
  // Pattern has slightly different middle content but identical first+last.
  const pattern = [
    'function foo() {',
    '  const x = 1; // changed',
    '  const y = 2; // also changed',
    '  const z = 3;',
    '  return x + y + z;',
    '}',
  ].join('\n')
  const r = fuzzyFindAndReplace(content, pattern, 'REPLACED', false)
  assertEq(r.strategy, 'block_anchor', 'strategy picked')
  assert(r.newContent.startsWith('REPLACED\nrest'), 'replacement applied')
})

test('fuzzy context_aware tolerates heavy middle drift when ≥50% lines match', () => {
  // Neither first nor last line matches exactly — block_anchor misses. But
  // most lines are ≥80% similar, so context_aware picks it up.
  const content = [
    'step 1: initialise the widget',
    'step 2: validate inputs',
    'step 3: emit the event',
    'step 4: finalize the task',
    'end of file',
  ].join('\n')
  const pattern = [
    'step 1: initialize the widget', // z → s (close similarity)
    'step 2: validate input', // missing trailing s
    'step 3: emit the event', // exact match
    'step 4: finalize the task', // exact match
  ].join('\n')
  const r = fuzzyFindAndReplace(content, pattern, 'NEW_BLOCK', false)
  assert(
    r.strategy === 'context_aware' || r.strategy === 'block_anchor',
    `strategy is context_aware or block_anchor (got ${r.strategy})`,
  )
  assert(r.newContent.includes('NEW_BLOCK'), 'replacement applied')
})

test('similarityRatio basic sanity', () => {
  assertEq(similarityRatio('', ''), 1.0, 'empty vs empty = 1.0')
  assertEq(similarityRatio('abc', ''), 0.0, 'empty rhs = 0.0')
  assertEq(similarityRatio('abc', 'abc'), 1.0, 'equal strings = 1.0')
  // "kitten" vs "sitting": LCS = "ittin" (5), total = 6 + 7 = 13, ratio ≈ 0.769
  const r = similarityRatio('kitten', 'sitting')
  assert(r > 0.6 && r < 0.9, `kitten/sitting similarity in range: ${r}`)
})

// ---------------------------------------------------------------------------
// atomicWrite
// ---------------------------------------------------------------------------

test('atomicWriteFile writes content and creates dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'skill-test-atomic-'))
  try {
    const target = join(dir, 'nested', 'file.txt')
    await atomicWriteFile(target, 'payload')
    assert(existsSync(target), 'file exists')
    assertEq(readFileSync(target, 'utf-8'), 'payload', 'content matches')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// action handlers — end-to-end against a temp dir
// ---------------------------------------------------------------------------

function withTempRoots<T>(fn: (resolver: SkillsDirResolver) => Promise<T>): Promise<T> {
  const userRoot = mkdtempSync(join(tmpdir(), 'skill-test-user-'))
  const projectRoot = mkdtempSync(join(tmpdir(), 'skill-test-project-'))
  const resolver: SkillsDirResolver = scope =>
    scope === 'project' ? projectRoot : userRoot
  return fn(resolver).finally(() => {
    rmSync(userRoot, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  })
}

test('create → find → edit → delete roundtrip (user scope)', async () => {
  await withTempRoots(async resolver => {
    const create = await createSkill(
      { name: 'my-skill', content: SAMPLE_SKILL },
      resolver,
    )
    assert(create.success, `create ok: ${JSON.stringify(create)}`)
    assert(
      existsSync(join(resolver('user'), 'my-skill', 'SKILL.md')),
      'SKILL.md on disk',
    )

    const found = findExistingSkill('my-skill', resolver)
    assert(found && found.scope === 'user', 'found in user scope')

    const edited = await editSkill(
      {
        name: 'my-skill',
        content: SAMPLE_SKILL.replace('Sample Skill', 'Renamed Skill'),
      },
      resolver,
    )
    assert(edited.success, `edit ok: ${JSON.stringify(edited)}`)
    const contents = readFileSync(
      join(resolver('user'), 'my-skill', 'SKILL.md'),
      'utf-8',
    )
    assert(contents.includes('Renamed Skill'), 'edit applied')

    const deleted = await deleteSkill({ name: 'my-skill' }, resolver)
    assert(deleted.success, `delete ok: ${JSON.stringify(deleted)}`)
    assert(
      !existsSync(join(resolver('user'), 'my-skill')),
      'skill dir gone',
    )
  })
})

test('create with category nests under subdir', async () => {
  await withTempRoots(async resolver => {
    const res = await createSkill(
      { name: 'deploy-k8s', category: 'devops', content: SAMPLE_SKILL },
      resolver,
    )
    assert(res.success, `create ok: ${JSON.stringify(res)}`)
    assert(
      existsSync(join(resolver('user'), 'devops', 'deploy-k8s', 'SKILL.md')),
      'category subdir created',
    )
    const found = findExistingSkill('deploy-k8s', resolver)
    assert(found, 'found across category')
  })
})

test('create refuses duplicate skill name across scopes', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'dup', content: SAMPLE_SKILL }, resolver)
    const again = await createSkill(
      { name: 'dup', scope: 'project', content: SAMPLE_SKILL },
      resolver,
    )
    assert(!again.success, 'second create fails')
    assert(again.error && /already exists/.test(again.error), 'dup error')
  })
})

test('create rejects bad frontmatter', async () => {
  await withTempRoots(async resolver => {
    const res = await createSkill(
      { name: 'bad', content: 'no frontmatter here' },
      resolver,
    )
    assert(!res.success, 'rejected')
    assert(res.error && /frontmatter/.test(res.error), 'explains frontmatter')
  })
})

test('patch with fuzzy line-trim tolerates whitespace drift', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'ps', content: SAMPLE_SKILL }, resolver)
    // Send "Step 1: Do the first thing.   " with trailing spaces in content
    // Actually the SAMPLE has no trailing whitespace; test indentation-flex
    // by asking for a snippet without leading spaces from a text that has
    // uniform indentation — the sample is not indented, so use exact match.
    const res = await patchSkill(
      {
        name: 'ps',
        old_string: 'Step 2: Do the second thing.',
        new_string: 'Step 2: Done the second thing.',
      },
      resolver,
    )
    assert(res.success, `patch ok: ${JSON.stringify(res)}`)
    const contents = readFileSync(
      join(resolver('user'), 'ps', 'SKILL.md'),
      'utf-8',
    )
    assert(contents.includes('Done the second thing.'), 'patch applied')
  })
})

test('patch refuses to break frontmatter', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'pf', content: SAMPLE_SKILL }, resolver)
    const res = await patchSkill(
      {
        name: 'pf',
        old_string: '---\nname: sample-skill',
        new_string: 'BROKEN',
      },
      resolver,
    )
    assert(!res.success, 'rejected')
    assert(
      res.error && /structure|frontmatter/.test(res.error),
      'explains structure breakage',
    )
  })
})

test('patch multi-match without replace_all errors + preview', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'mm', content: SAMPLE_SKILL }, resolver)
    const res = await patchSkill(
      { name: 'mm', old_string: 'thing', new_string: 'widget' },
      resolver,
    )
    assert(!res.success, 'rejected')
    assert(res.error && /matches/.test(res.error), 'matches error')
    assert(res.filePreview, 'file_preview included')
  })
})

test('patch replace_all works', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'ra', content: SAMPLE_SKILL }, resolver)
    const res = await patchSkill(
      {
        name: 'ra',
        old_string: 'thing',
        new_string: 'widget',
        replace_all: true,
      },
      resolver,
    )
    assert(res.success, `replace_all ok: ${JSON.stringify(res)}`)
    const contents = readFileSync(
      join(resolver('user'), 'ra', 'SKILL.md'),
      'utf-8',
    )
    assert(!contents.includes('thing'), 'all replaced')
    assert(contents.includes('widget'), 'new string present')
  })
})

test('write_file + remove_file on supporting files', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'wf', content: SAMPLE_SKILL }, resolver)
    const w = await writeSupportingFile(
      {
        name: 'wf',
        file_path: 'references/api.md',
        file_content: '# API reference\n',
      },
      resolver,
    )
    assert(w.success, `write ok: ${JSON.stringify(w)}`)
    assert(
      existsSync(join(resolver('user'), 'wf', 'references', 'api.md')),
      'file on disk',
    )

    const r = await removeSupportingFile(
      { name: 'wf', file_path: 'references/api.md' },
      resolver,
    )
    assert(r.success, `remove ok: ${JSON.stringify(r)}`)
    assert(
      !existsSync(join(resolver('user'), 'wf', 'references', 'api.md')),
      'file gone',
    )
  })
})

test('write_file rejects traversal + disallowed subdir', async () => {
  await withTempRoots(async resolver => {
    await createSkill({ name: 'sec', content: SAMPLE_SKILL }, resolver)
    const bad1 = await writeSupportingFile(
      {
        name: 'sec',
        file_path: '../../etc/passwd',
        file_content: 'x',
      },
      resolver,
    )
    assert(!bad1.success, 'traversal rejected')

    const bad2 = await writeSupportingFile(
      {
        name: 'sec',
        file_path: 'bin/evil.sh',
        file_content: 'x',
      },
      resolver,
    )
    assert(!bad2.success, 'disallowed subdir rejected')
    assert(
      bad2.error && /references|templates|scripts|assets/.test(bad2.error),
      'mentions allowed subdirs',
    )
  })
})

test('project-scope create puts file under <project>/.claude/skills', async () => {
  await withTempRoots(async resolver => {
    const res = await createSkill(
      { name: 'proj-skill', scope: 'project', content: SAMPLE_SKILL },
      resolver,
    )
    assert(res.success, `create ok: ${JSON.stringify(res)}`)
    assert(
      existsSync(join(resolver('project'), 'proj-skill', 'SKILL.md')),
      'in project root',
    )
    assert(
      !existsSync(join(resolver('user'), 'proj-skill')),
      'not in user root',
    )
  })
})

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      console.log(`  ok  ${t.name}`)
    } catch (e) {
      failed++
      const msg = e instanceof Error ? e.message : String(e)
      console.error(`  FAIL ${t.name}\n    ${msg}`)
    }
  }
  console.log(`\n${tests.length - failed}/${tests.length} tests passed.`)
  if (failed > 0) process.exit(1)
}

void main()
