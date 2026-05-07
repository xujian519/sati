/**
 * Smoke test: verify SkillManageTool is discoverable + schema-valid.
 * Run: bun src/tools/SkillManageTool/smokeTest.ts
 */

import { SkillManageTool } from './SkillManageTool.js'

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`FAIL: ${msg}`)
    process.exit(1)
  }
}

// Schema + identity
assert(SkillManageTool.name === 'SkillManage', 'name is SkillManage')
assert(typeof SkillManageTool.inputSchema === 'object', 'has inputSchema')
assert(!SkillManageTool.isReadOnly(), 'not readOnly')
assert(!SkillManageTool.isConcurrencySafe(), 'not concurrency-safe')
assert(SkillManageTool.isEnabled(), 'isEnabled=true by default')

const description = await SkillManageTool.description()
assert(
  description.includes('skill') || description.includes('Skill'),
  `description mentions skill: ${description}`,
)

// Input schema accepts minimal valid input
const schema = SkillManageTool.inputSchema
const parsed = schema.safeParse({ action: 'create', name: 'my-skill' })
assert(parsed.success, `schema accepts minimal create: ${parsed.error?.message}`)

// Schema rejects unknown action
const bad = schema.safeParse({ action: 'nuke', name: 'x' })
assert(!bad.success, 'schema rejects unknown action')

console.log('smoke OK: SkillManage is discoverable and schema-valid')
