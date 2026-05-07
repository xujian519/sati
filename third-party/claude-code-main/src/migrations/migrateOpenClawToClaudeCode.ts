/**
 * OpenClaw -> Claude Code migration (Skills / Plugins / MCP).
 *
 * Migrates:
 *   - Skills (SKILL.md directories) into ~/.claude/skills/
 *   - MCP server definitions into .mcp.json
 *   - Plugin configs archived for manual review
 *
 * Designed to run standalone via `bun run` or be imported by other modules.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, relative, resolve } from 'node:path'
import { homedir } from 'node:os'

// ─── Types ───────────────────────────────────────────────────

interface ItemResult {
  kind: string
  source: string | null
  destination: string | null
  status: 'migrated' | 'archived' | 'skipped' | 'conflict' | 'error'
  reason: string
  details: Record<string, unknown>
}

interface MigrationReport {
  timestamp: string
  mode: 'execute' | 'dry-run'
  sourceRoot: string
  targetRoot: string
  mcpTarget: string
  outputDir: string | null
  preset: string | null
  skillConflictMode: string
  summary: Record<string, number>
  items: ItemResult[]
}

interface MigrationOptions {
  sourceRoot: string
  targetRoot: string
  mcpTarget: string
  execute: boolean
  overwrite: boolean
  outputDir?: string
  selectedOptions?: Set<string>
  preset?: string
  skillConflictMode?: 'skip' | 'overwrite' | 'rename'
}

type OpenClawConfig = Record<string, unknown>

// ─── Constants ───────────────────────────────────────────────

const SKILL_CONFLICT_MODES = new Set(['skip', 'overwrite', 'rename'])

const MIGRATION_OPTIONS: Record<string, { label: string; description: string }> = {
  'skills': {
    label: 'Workspace skills',
    description: 'Copy OpenClaw workspace skills into ~/.claude/skills/.',
  },
  'shared-skills': {
    label: 'Shared skills',
    description: 'Copy shared OpenClaw skills from ~/.openclaw/skills/ and ~/.agents/skills/.',
  },
  'mcp-servers': {
    label: 'MCP servers',
    description: 'Import MCP server definitions from OpenClaw into .mcp.json.',
  },
  'plugins-config': {
    label: 'Plugins configuration',
    description: 'Archive OpenClaw plugin configuration and installed extensions.',
  },
  'skills-config': {
    label: 'Skills registry',
    description: 'Archive per-skill enabled/config/env settings from OpenClaw.',
  },
}

const MIGRATION_PRESETS: Record<string, Set<string>> = {
  'default': new Set(Object.keys(MIGRATION_OPTIONS)),
  'skills-only': new Set(['skills', 'shared-skills', 'skills-config']),
  'mcp-only': new Set(['mcp-servers']),
}

// ─── Helpers ─────────────────────────────────────────────────

function sha256File(path: string): string {
  const data = readFileSync(path)
  return createHash('sha256').update(data).digest('hex')
}

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
}

function backupPath(path: string, backupRoot: string): string | null {
  if (!existsSync(path)) return null
  const homeDir = homedir()
  const rel = path.startsWith(homeDir) ? relative(homeDir, path) : basename(path)
  const dest = join(backupRoot, rel)
  ensureDir(join(dest, '..'))
  cpSync(path, dest, { recursive: true })
  return dest
}

function loadJsonFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    const data = JSON.parse(readFileSync(path, 'utf-8'))
    return typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {}
  } catch {
    return {}
  }
}

function writeJsonFile(path: string, data: unknown): void {
  ensureDir(join(path, '..'))
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8')
}

function isDir(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

// ─── Migrator ────────────────────────────────────────────────

export class OpenClawMigrator {
  private sourceRoot: string
  private targetRoot: string
  private mcpTarget: string
  private execute: boolean
  private overwrite: boolean
  private selectedOptions: Set<string>
  private preset: string
  private skillConflictMode: string
  private timestamp: string
  private outputDir: string | null
  private archiveDir: string | null
  private backupDir: string | null
  private items: ItemResult[] = []

  constructor(opts: MigrationOptions) {
    this.sourceRoot = resolve(opts.sourceRoot)
    this.targetRoot = resolve(opts.targetRoot)
    this.mcpTarget = resolve(opts.mcpTarget)
    this.execute = opts.execute
    this.overwrite = opts.overwrite
    this.selectedOptions = opts.selectedOptions ?? new Set(Object.keys(MIGRATION_OPTIONS))
    this.preset = opts.preset ?? ''
    this.skillConflictMode = opts.skillConflictMode ?? 'skip'
    this.timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', 'T')

    if (!SKILL_CONFLICT_MODES.has(this.skillConflictMode)) {
      throw new Error(`Unknown skill conflict mode: ${this.skillConflictMode}. Valid: ${[...SKILL_CONFLICT_MODES].join(', ')}`)
    }

    if (opts.outputDir) {
      this.outputDir = resolve(opts.outputDir)
    } else if (opts.execute) {
      this.outputDir = join(this.targetRoot, 'migration', 'openclaw', this.timestamp)
    } else {
      this.outputDir = null
    }
    this.archiveDir = this.outputDir ? join(this.outputDir, 'archive') : null
    this.backupDir = this.outputDir ? join(this.outputDir, 'backups') : null
  }

  private record(kind: string, source: string | null, destination: string | null,
                  status: ItemResult['status'], reason = '', details: Record<string, unknown> = {}): void {
    this.items.push({ kind, source, destination, status, reason, details })
  }

  private isSelected(id: string): boolean {
    return this.selectedOptions.has(id)
  }

  private runIfSelected(id: string, fn: () => void): void {
    if (this.isSelected(id)) {
      fn()
    } else {
      this.record(id, null, null, 'skipped', 'Not selected for this run')
    }
  }

  private sourceCandidate(...relativePaths: string[]): string | null {
    for (const rel of relativePaths) {
      const candidate = join(this.sourceRoot, rel)
      if (existsSync(candidate)) return candidate
      if (rel.startsWith('workspace/')) {
        const suffix = rel.slice('workspace/'.length)
        for (const variant of ['workspace-main', 'workspace-assistant']) {
          const alt = join(this.sourceRoot, variant, suffix)
          if (existsSync(alt)) return alt
        }
      }
    }
    return null
  }

  private maybeBackup(path: string): string | null {
    if (!this.execute || !this.backupDir || !existsSync(path)) return null
    return backupPath(path, this.backupDir)
  }

  private resolveSkillDestination(destination: string): string {
    if (this.skillConflictMode !== 'rename' || !existsSync(destination)) return destination
    let candidate = destination + '-imported'
    let counter = 2
    while (existsSync(candidate)) {
      candidate = `${destination}-imported-${counter}`
      counter++
    }
    return candidate
  }

  private loadOpenClawConfig(): OpenClawConfig {
    for (const name of ['openclaw.json', 'clawdbot.json', 'moltbot.json']) {
      const config = loadJsonFile(join(this.sourceRoot, name))
      if (Object.keys(config).length > 0) return config
    }
    return {}
  }

  // ── Skills ──────────────────────────────────────────────

  private migrateSkills(): void {
    const sourceRoot = this.sourceCandidate('workspace/skills')
    const destRoot = join(this.targetRoot, 'skills')
    if (!sourceRoot || !isDir(sourceRoot)) {
      this.record('skills', null, destRoot, 'skipped', 'No OpenClaw workspace skills directory found')
      return
    }
    const skillDirs = readdirSync(sourceRoot)
      .filter(name => isDir(join(sourceRoot, name)) && isFile(join(sourceRoot, name, 'SKILL.md')))
      .sort()

    if (skillDirs.length === 0) {
      this.record('skills', sourceRoot, destRoot, 'skipped', 'No skills with SKILL.md found')
      return
    }
    for (const name of skillDirs) {
      this.copySkill(join(sourceRoot, name), destRoot, 'skill')
    }
  }

  private migrateSharedSkills(): void {
    const sources: Array<[string, string]> = [
      [join(this.sourceRoot, 'skills'), 'managed skills'],
      [join(homedir(), '.agents', 'skills'), 'personal cross-project skills'],
      [join(this.sourceRoot, 'workspace', '.agents', 'skills'), 'project-level shared skills'],
      [join(this.sourceRoot, 'workspace.default', '.agents', 'skills'), 'project-level shared skills (default)'],
    ]
    let found = false
    for (const [srcDir, _desc] of sources) {
      if (!isDir(srcDir)) continue
      const skillDirs = readdirSync(srcDir)
        .filter(name => isDir(join(srcDir, name)) && isFile(join(srcDir, name, 'SKILL.md')))
        .sort()
      if (skillDirs.length > 0) {
        found = true
        for (const name of skillDirs) {
          this.copySkill(join(srcDir, name), join(this.targetRoot, 'skills'), 'shared-skill')
        }
      }
    }
    if (!found) {
      this.record('shared-skills', null, join(this.targetRoot, 'skills'), 'skipped',
        'No shared OpenClaw skills directories found')
    }
  }

  private copySkill(skillDir: string, destRoot: string, kind: string): void {
    const name = basename(skillDir)
    let destination = join(destRoot, name)
    let finalDest = destination

    if (existsSync(destination)) {
      if (this.skillConflictMode === 'skip') {
        this.record(kind, skillDir, destination, 'conflict', 'Destination skill already exists')
        return
      }
      if (this.skillConflictMode === 'rename') {
        finalDest = this.resolveSkillDestination(destination)
      }
    }

    if (this.execute) {
      let backup: string | null = null
      if (finalDest === destination && existsSync(destination)) {
        backup = this.maybeBackup(destination)
        rmSync(destination, { recursive: true, force: true })
      }
      ensureDir(join(finalDest, '..'))
      cpSync(skillDir, finalDest, { recursive: true })
      const details: Record<string, unknown> = {}
      if (backup) details.backup = backup
      if (finalDest !== destination) details.renamedFrom = destination
      this.record(kind, skillDir, finalDest, 'migrated', '', details)
    } else {
      const details: Record<string, unknown> = {}
      if (finalDest !== destination) details.renamedFrom = destination
      this.record(kind, skillDir, finalDest, 'migrated',
        finalDest !== destination ? 'Would copy under a renamed folder' : 'Would copy skill directory',
        details)
    }
  }

  // ── MCP servers ─────────────────────────────────────────

  private migrateMcpServers(config: OpenClawConfig): void {
    const mcpBlock = (config.mcp ?? {}) as Record<string, unknown>
    const serversRaw = (mcpBlock.servers ?? {}) as Record<string, Record<string, unknown>>

    if (Object.keys(serversRaw).length === 0) {
      this.record('mcp-servers', null, null, 'skipped', 'No MCP servers found in OpenClaw config')
      return
    }

    let existing: Record<string, unknown> = {}
    if (existsSync(this.mcpTarget)) {
      const data = loadJsonFile(this.mcpTarget)
      existing = (data.mcpServers ?? {}) as Record<string, unknown>
    }

    let added = 0

    for (const [name, srv] of Object.entries(serversRaw)) {
      if (typeof srv !== 'object' || srv === null) continue

      if (name in existing && !this.overwrite) {
        this.record('mcp-server', `mcp.servers.${name}`, `mcpServers.${name}`,
          'conflict', 'MCP server already exists in .mcp.json')
        continue
      }

      const ccSrv: Record<string, unknown> = {}
      const command = srv.command as string | undefined
      const url = srv.url as string | undefined

      if (command) {
        ccSrv.command = command
        if (srv.args) ccSrv.args = srv.args
        if (srv.env) ccSrv.env = srv.env
      } else if (url) {
        ccSrv.type = 'sse'
        ccSrv.url = url
        if (srv.headers) ccSrv.headers = srv.headers
      } else {
        this.record('mcp-server', `mcp.servers.${name}`, null, 'skipped',
          'No command or url found — cannot determine transport')
        continue
      }

      const dropped: string[] = []
      if (srv.enabled === false) dropped.push('enabled=false (server is disabled)')
      if (srv.tools) dropped.push('tools filtering (configure in settings.json)')
      if (srv.sampling) dropped.push('sampling config (not in .mcp.json)')
      if (srv.cwd) dropped.push(`cwd=${srv.cwd} (not in .mcp.json schema)`)
      if (srv.connectTimeout || srv.timeout) dropped.push('timeout settings (not in .mcp.json)')

      if (srv.enabled === false) {
        this.record('mcp-server', `mcp.servers.${name}`, null, 'skipped',
          'Server is disabled in OpenClaw config', { droppedFields: dropped })
        continue
      }

      existing[name] = ccSrv
      added++
      this.record('mcp-server', `mcp.servers.${name}`, `mcpServers.${name}`,
        'migrated', this.execute ? '' : 'Would add to .mcp.json',
        { droppedFields: dropped.length > 0 ? dropped : undefined })
    }

    if (added > 0 && this.execute) {
      this.maybeBackup(this.mcpTarget)
      writeJsonFile(this.mcpTarget, { mcpServers: existing })
    }
  }

  // ── Plugins (archive only) ──────────────────────────────

  private migratePluginsConfig(config: OpenClawConfig): void {
    const plugins = config.plugins as Record<string, unknown> | undefined
    if (!plugins || Object.keys(plugins).length === 0) {
      this.record('plugins-config', null, null, 'skipped', 'No plugins configuration found')
      return
    }

    if (this.archiveDir && this.execute) {
      ensureDir(this.archiveDir)
      const dest = join(this.archiveDir, 'plugins-config.json')
      writeJsonFile(dest, plugins)
      this.record('plugins-config', 'openclaw.json plugins.*', dest, 'archived',
        'Plugins config archived for manual review')
    } else {
      this.record('plugins-config', 'openclaw.json plugins.*', 'archive/plugins-config.json',
        'archived', 'Would archive plugins config')
    }

    const extDir = join(this.sourceRoot, 'extensions')
    if (isDir(extDir) && this.archiveDir) {
      const destExt = join(this.archiveDir, 'extensions')
      if (this.execute) {
        cpSync(extDir, destExt, { recursive: true })
      }
      this.record('plugins-config', extDir, destExt, 'archived', 'Extensions directory archived')
    }
  }

  // ── Skills registry (archive only) ──────────────────────

  private migrateSkillsConfig(config: OpenClawConfig): void {
    const skills = (config.skills ?? {}) as Record<string, unknown>
    const entries = (skills.entries ?? {}) as Record<string, unknown>
    if (Object.keys(entries).length === 0 && Object.keys(skills).length === 0) {
      this.record('skills-config', null, null, 'skipped', 'No skills registry configuration found')
      return
    }

    if (this.archiveDir && this.execute) {
      ensureDir(this.archiveDir)
      writeJsonFile(join(this.archiveDir, 'skills-registry-config.json'), skills)
    }
    this.record('skills-config', 'openclaw.json skills.*', 'archive/skills-registry-config.json',
      'archived', `Skills registry config (${Object.keys(entries).length} entries) archived`)
  }

  // ── Main entry ──────────────────────────────────────────

  migrate(): MigrationReport {
    if (!existsSync(this.sourceRoot)) {
      this.record('source', this.sourceRoot, null, 'error', 'OpenClaw directory does not exist')
      return this.buildReport()
    }

    const config = this.loadOpenClawConfig()

    this.runIfSelected('skills', () => this.migrateSkills())
    this.runIfSelected('shared-skills', () => this.migrateSharedSkills())
    this.runIfSelected('mcp-servers', () => this.migrateMcpServers(config))
    this.runIfSelected('plugins-config', () => this.migratePluginsConfig(config))
    this.runIfSelected('skills-config', () => this.migrateSkillsConfig(config))

    return this.buildReport()
  }

  private buildReport(): MigrationReport {
    const summary: Record<string, number> = { migrated: 0, archived: 0, skipped: 0, conflict: 0, error: 0 }
    for (const item of this.items) {
      summary[item.status] = (summary[item.status] ?? 0) + 1
    }

    const report: MigrationReport = {
      timestamp: this.timestamp,
      mode: this.execute ? 'execute' : 'dry-run',
      sourceRoot: this.sourceRoot,
      targetRoot: this.targetRoot,
      mcpTarget: this.mcpTarget,
      outputDir: this.outputDir,
      preset: this.preset || null,
      skillConflictMode: this.skillConflictMode,
      summary,
      items: this.items,
    }

    if (this.outputDir) {
      ensureDir(this.outputDir)
      writeJsonFile(join(this.outputDir, 'report.json'), report)

      const lines = [
        '# OpenClaw -> Claude Code Migration Report', '',
        `- Timestamp: ${report.timestamp}`,
        `- Mode: ${report.mode}`,
        `- Source: \`${report.sourceRoot}\``,
        `- Target: \`${report.targetRoot}\``, '',
        '## Summary', '',
        ...Object.entries(summary).map(([k, v]) => `- ${k}: ${v}`), '',
        '## Items Not Fully Brought Over', '',
      ]
      const notDone = this.items.filter(i => ['skipped', 'conflict', 'error'].includes(i.status))
      if (notDone.length === 0) {
        lines.push('- Nothing. All items were migrated or archived.')
      } else {
        for (const item of notDone) {
          lines.push(`- \`${item.source ?? '(n/a)'}\` -> \`${item.destination ?? '(n/a)'}\`: ${item.reason || item.status}`)
        }
      }
      writeFileSync(join(this.outputDir, 'summary.md'), lines.join('\n') + '\n', 'utf-8')
    }

    return report
  }
}

// ─── CLI ─────────────────────────────────────────────────────

function resolveSelectedOptions(include: string[], exclude: string[], preset?: string): Set<string> {
  const valid = new Set(Object.keys(MIGRATION_OPTIONS))

  if (preset) {
    const presetSet = MIGRATION_PRESETS[preset]
    if (!presetSet) throw new Error(`Unknown preset: ${preset}. Valid: ${Object.keys(MIGRATION_PRESETS).join(', ')}`)
    const result = new Set(presetSet)
    for (const e of exclude) result.delete(e)
    return result
  }

  let result: Set<string>
  if (include.length === 0 || include.includes('all')) {
    result = new Set(valid)
  } else {
    for (const i of include) {
      if (!valid.has(i)) throw new Error(`Unknown option: ${i}. Valid: ${[...valid].join(', ')}`)
    }
    result = new Set(include)
  }
  for (const e of exclude) result.delete(e)
  return result
}

function parseArgs(argv: string[]): MigrationOptions & { help: boolean } {
  const args = argv.slice(2)
  let source = join(homedir(), '.openclaw')
  let target = join(homedir(), '.claude')
  let mcpTarget = '.mcp.json'
  let execute = false
  let overwrite = false
  let skillConflict: 'skip' | 'overwrite' | 'rename' = 'skip'
  let preset: string | undefined
  const include: string[] = []
  const exclude: string[] = []
  let outputDir: string | undefined
  let help = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const next = () => { i++; return args[i] }
    switch (arg) {
      case '--source': source = next()!; break
      case '--target': target = next()!; break
      case '--mcp-target': mcpTarget = next()!; break
      case '--execute': execute = true; break
      case '--overwrite': overwrite = true; break
      case '--skill-conflict': skillConflict = next()! as 'skip' | 'overwrite' | 'rename'; break
      case '--preset': preset = next()!; break
      case '--include': include.push(...(next()!).split(',')); break
      case '--exclude': exclude.push(...(next()!).split(',')); break
      case '--output-dir': outputDir = next()!; break
      case '--help': case '-h': help = true; break
    }
  }

  const selected = resolveSelectedOptions(include, exclude, preset)

  return {
    sourceRoot: source, targetRoot: target, mcpTarget,
    execute, overwrite, outputDir,
    selectedOptions: selected, preset,
    skillConflictMode: skillConflict,
    help,
  }
}

export function printReport(report: MigrationReport): void {
  const s = report.summary
  const items = report.items
  const mode = report.mode === 'execute' ? 'EXECUTED' : 'DRY RUN'
  const total = Object.values(s).reduce((a, b) => a + b, 0)

  const pad = (str: string, len: number) => str.slice(0, len).padEnd(len)

  console.log()
  console.log('  ╔══════════════════════════════════════════════════════╗')
  console.log(`  ║  OpenClaw -> Claude Code Migration  [${mode.padStart(8)}]  ║`)
  console.log('  ╠══════════════════════════════════════════════════════╣')
  console.log(`  ║  Source:  ${pad(report.sourceRoot, 42)}  ║`)
  console.log(`  ║  Target:  ${pad(report.targetRoot, 42)}  ║`)
  console.log(`  ║  MCP:     ${pad(report.mcpTarget, 42)}  ║`)
  console.log('  ╠══════════════════════════════════════════════════════╣')
  console.log(`  ║  + Migrated:  ${String(s.migrated ?? 0).padStart(3)}    * Archived:  ${String(s.archived ?? 0).padStart(3)}        ║`)
  console.log(`  ║  - Skipped:   ${String(s.skipped ?? 0).padStart(3)}    ! Conflicts: ${String(s.conflict ?? 0).padStart(3)}        ║`)
  console.log(`  ║  x Errors:    ${String(s.error ?? 0).padStart(3)}    Total:       ${String(total).padStart(3)}        ║`)
  console.log('  ╚══════════════════════════════════════════════════════╝')

  const migrated = items.filter(i => i.status === 'migrated')
  if (migrated.length > 0) {
    console.log()
    console.log('  Migrated:')
    for (const item of migrated) {
      let dest = item.destination ?? ''
      if (dest.startsWith(report.targetRoot)) {
        dest = '~/.claude/' + dest.slice(report.targetRoot.length + 1)
      }
      const label = MIGRATION_OPTIONS[item.kind]?.label ?? item.kind
      console.log(`    + ${label.padEnd(35)} -> ${dest}`)
      const dropped = item.details?.droppedFields as string[] | undefined
      if (dropped) {
        for (const d of dropped) console.log(`        (dropped: ${d})`)
      }
    }
  }

  const archived = items.filter(i => i.status === 'archived')
  if (archived.length > 0) {
    console.log()
    console.log('  Archived (manual review needed):')
    const seen = new Set<string>()
    for (const item of archived) {
      if (seen.has(item.kind)) continue
      seen.add(item.kind)
      const label = MIGRATION_OPTIONS[item.kind]?.label ?? item.kind
      console.log(`    * ${label.padEnd(35)}  ${(item.reason ?? '').slice(0, 60)}`)
    }
  }

  const conflicts = items.filter(i => i.status === 'conflict')
  if (conflicts.length > 0) {
    console.log()
    console.log('  Conflicts (use --overwrite to force):')
    for (const item of conflicts) {
      console.log(`    ! ${item.kind}: ${item.reason ?? ''}`)
    }
  }

  const errors = items.filter(i => i.status === 'error')
  if (errors.length > 0) {
    console.log()
    console.log('  Errors:')
    for (const item of errors) {
      console.log(`    x ${item.kind}: ${item.reason ?? ''}`)
    }
  }

  if (report.mode === 'execute' && report.outputDir) {
    console.log()
    console.log(`  Report: ${report.outputDir}/report.json`)
  } else if (report.mode === 'dry-run') {
    console.log()
    console.log('  This was a dry run. Add --execute to apply changes.')
  }
  console.log()
}

const HELP_TEXT = `
Usage: bun run src/migrations/migrateOpenClawToClaudeCode.ts [options]

Migrate OpenClaw skills, plugins, and MCP servers into Claude Code.

Options:
  --source DIR       OpenClaw home directory (default: ~/.openclaw)
  --target DIR       Claude Code config directory (default: ~/.claude)
  --mcp-target FILE  Where to write MCP servers (default: ./.mcp.json)
  --execute          Apply changes (default: dry run)
  --overwrite        Overwrite existing targets with backup
  --skill-conflict   skip|overwrite|rename (default: skip)
  --preset           default|skills-only|mcp-only
  --include IDS      Comma-separated option ids to include
  --exclude IDS      Comma-separated option ids to exclude
  --output-dir DIR   Where to write report and archives
  -h, --help         Show this help

Valid option ids: ${Object.keys(MIGRATION_OPTIONS).join(', ')}
`

// ─── Main ────────────────────────────────────────────────────

if (import.meta.main || process.argv[1]?.endsWith('migrateOpenClawToClaudeCode.ts')) {
  const opts = parseArgs(process.argv)
  if (opts.help) {
    console.log(HELP_TEXT)
    process.exit(0)
  }

  const migrator = new OpenClawMigrator(opts)
  const report = migrator.migrate()
  printReport(report)

  if (process.env.MIGRATION_JSON_OUTPUT) {
    console.log(JSON.stringify(report, null, 2))
  }

  process.exit((report.summary.error ?? 0) > 0 ? 1 : 0)
}
