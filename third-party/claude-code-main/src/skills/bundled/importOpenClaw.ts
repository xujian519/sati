import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerBundledSkill } from '../bundledSkills.js'

const OPENCLAW_DIR_CANDIDATES = ['.openclaw', '.clawdbot', '.moldbot', '.moltbot']
const CONFIG_FILENAMES = ['openclaw.json', 'clawdbot.json', 'moldbot.json', 'moltbot.json']

const MIGRATION_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'migrations', 'migrateOpenClawToClaudeCode.ts',
)

function detectOpenClawDir(): string | null {
  const envOverride = process.env.OPENCLAW_STATE_DIR?.trim() || process.env.CLAWDBOT_STATE_DIR?.trim()
  if (envOverride && existsSync(envOverride)) return envOverride

  const home = homedir()
  for (const name of OPENCLAW_DIR_CANDIDATES) {
    const candidate = join(home, name)
    try {
      if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate
    } catch { /* ignore permission errors */ }
  }
  return null
}

function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILENAMES) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

function countSkills(dir: string): number {
  const skillsDir = [
    join(dir, 'workspace', 'skills'),
    join(dir, 'workspace-main', 'skills'),
  ].find(d => existsSync(d))
  if (!skillsDir) return 0
  try {
    return readdirSync(skillsDir).filter(name => {
      const skillMd = join(skillsDir, name, 'SKILL.md')
      try { return statSync(join(skillsDir, name)).isDirectory() && existsSync(skillMd) } catch { return false }
    }).length
  } catch { return 0 }
}

export function registerImportOpenClawSkill(): void {
  registerBundledSkill({
    name: 'import-openclaw',
    description:
      'Migrate skills, MCP servers, and plugin configs from an OpenClaw installation into Claude Code.',
    whenToUse:
      'Use when the user mentions OpenClaw, wants to migrate from OpenClaw, ClawdBot, or MoltBot, or asks about importing OpenClaw skills, MCP servers, or plugins into Claude Code.',
    userInvocable: true,
    allowedTools: ['Read', 'Grep', 'Glob', 'Shell', 'Write'],
    async getPromptForCommand(args) {
      const detected = detectOpenClawDir()
      const configFile = detected ? findConfigFile(detected) : null
      const skillCount = detected ? countSkills(detected) : 0

      let detectionInfo: string
      if (detected) {
        detectionInfo = `## Auto-detected OpenClaw directory

- **Path:** \`${detected}\`
- **Config file:** ${configFile ? `\`${configFile}\`` : 'not found'}
- **Workspace skills found:** ${skillCount}

The OpenClaw directory was auto-detected. Proceed with the migration workflow below.`
      } else {
        detectionInfo = `## OpenClaw directory NOT found

Checked the following locations:
${OPENCLAW_DIR_CANDIDATES.map(n => `- \`~/${n}\``).join('\n')}
- \`$OPENCLAW_STATE_DIR\` / \`$CLAWDBOT_STATE_DIR\` environment variables

**Ask the user** to provide the path to their OpenClaw directory before proceeding.`
      }

      const scriptExists = existsSync(MIGRATION_SCRIPT)
      const scriptCmd = `bun run ${MIGRATION_SCRIPT}`

      const prompt = `# Import OpenClaw into Claude Code

${detectionInfo}

${!scriptExists ? `> **Warning:** Migration script not found at \`${MIGRATION_SCRIPT}\`.\n` : ''}

## CRITICAL: Complete ALL steps in a SINGLE turn

You MUST complete steps 1-2 in ONE response without stopping. Do NOT output partial text and end the turn. Run the dry-run command IMMEDIATELY after inventory — do not pause or ask for permission to run it.

## Step 1: Run dry-run IMMEDIATELY

Skip reading the config file manually. Instead, run the migration script directly — it reads the config itself:

\`\`\`bash
${scriptCmd} \\
  --source ${detected || '<OPENCLAW_DIR>'} \\
  --target ~/.claude \\
  --mcp-target ./.mcp.json
\`\`\`

## Step 2: Present results and ask for confirmation

After the dry-run completes, show the user the summary and ask:
1. Whether to proceed with the migration
2. Skill conflict handling preference: skip (default) / overwrite / rename
3. Whether to migrate all categories or only specific ones

## Step 3: Execute (after user confirms)

\`\`\`bash
${scriptCmd} \\
  --source ${detected || '<OPENCLAW_DIR>'} \\
  --target ~/.claude \\
  --mcp-target ./.mcp.json \\
  --execute \\
  --skill-conflict <skip|overwrite|rename> \\
  --output-dir ~/.claude/migration/openclaw
\`\`\`

Then report the results.

## Rules
- Do NOT read openclaw.json manually — the script handles that.
- Do NOT stop between inventory and dry-run. Run the dry-run command in the same turn.
- Do NOT modify the OpenClaw directory (read-only import).
`

      if (args) {
        return [{ type: 'text', text: prompt + `\n## Additional context from user\n\n${args}` }]
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
