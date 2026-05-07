/**
 * Shared helpers for the bundled project-management skills
 * (/projects, /add-project, /switch-project, /pwd, /clone-repo).
 *
 * Kept deliberately dependency-free — these run inside the CLI subprocess
 * spawned by TUI, the gateway, and claudecodeui, so they must only touch
 * ~/.claude/ files that all three frontends already share.
 */

import { promises as fs, existsSync, createReadStream } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'

export interface ProjectInfo {
  /** Encoded directory name under `~/.claude/projects/`. */
  name: string
  /** Human-readable name (package.json `name`, explicit `displayName`, or basename). */
  displayName: string
  /** Absolute filesystem path. */
  path: string
  /** Whether this project was added manually vs. auto-discovered from ~/.claude/projects. */
  manuallyAdded: boolean
}

export type ProjectConfig = Record<
  string,
  {
    manuallyAdded?: boolean
    originalPath?: string
    displayName?: string
  }
>

const CONFIG_PATH = path.join(homedir(), '.claude', 'project-config.json')
const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects')
export const GATEWAY_STATE_DIR = path.join(homedir(), '.claude', 'gateway-user-state')

export async function loadProjectConfig(): Promise<ProjectConfig> {
  try {
    const data = await fs.readFile(CONFIG_PATH, 'utf8')
    return JSON.parse(data) as ProjectConfig
  } catch {
    return {}
  }
}

export async function saveProjectConfig(config: ProjectConfig): Promise<void> {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')
}

/** Encode an absolute path the same way claudecodeui does (compatible with its directory layout). */
export function encodeProjectName(absolutePath: string): string {
  return absolutePath.replace(/[\\/:\s~_]/g, '-')
}

/** Expand a leading `~` to `$HOME`. */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return path.join(homedir(), p.slice(2))
  return p
}

/**
 * Shell-ish tokenizer: splits on whitespace, honoring single/double quotes
 * and backslash escapes. Handles `/add-project "/tmp/my project" "My Name"`.
 */
export function parseArgs(raw: string): string[] {
  const out: string[] = []
  let buf = ''
  let quote: '"' | "'" | null = null
  let escaping = false
  for (const ch of raw) {
    if (escaping) {
      buf += ch
      escaping = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaping = true
      continue
    }
    if (quote) {
      if (ch === quote) {
        quote = null
      } else {
        buf += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (buf.length > 0) {
        out.push(buf)
        buf = ''
      }
      continue
    }
    buf += ch
  }
  if (buf.length > 0) out.push(buf)
  return out
}

async function generateDisplayName(projectName: string, projectDir: string | null): Promise<string> {
  const projectPath = projectDir || projectName.replace(/-/g, '/')
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'))
    if (pkg.name && typeof pkg.name === 'string') return pkg.name
  } catch {}
  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean)
    return parts[parts.length - 1] || projectPath
  }
  return projectPath
}

async function extractProjectDirectory(projectName: string): Promise<string> {
  const config = await loadProjectConfig()
  if (config[projectName]?.originalPath) return config[projectName].originalPath!

  const projectDir = path.join(PROJECTS_DIR, projectName)
  try {
    await fs.access(projectDir)
  } catch {
    return projectName.replace(/-/g, '/')
  }

  const cwdCounts = new Map<string, number>()
  let latestTimestamp = 0
  let latestCwd: string | null = null

  try {
    const files = await fs.readdir(projectDir)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))
    if (jsonlFiles.length === 0) return projectName.replace(/-/g, '/')

    for (const file of jsonlFiles) {
      const stream = createReadStream(path.join(projectDir, file))
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (entry.cwd) {
            cwdCounts.set(entry.cwd, (cwdCounts.get(entry.cwd) || 0) + 1)
            const ts = new Date(entry.timestamp || 0).getTime()
            if (ts > latestTimestamp) {
              latestTimestamp = ts
              latestCwd = entry.cwd
            }
          }
        } catch {}
      }
    }
  } catch {
    return projectName.replace(/-/g, '/')
  }

  if (cwdCounts.size === 0) return projectName.replace(/-/g, '/')
  if (cwdCounts.size === 1) return [...cwdCounts.keys()][0]!

  const mostRecentCount = cwdCounts.get(latestCwd!) || 0
  const maxCount = Math.max(...cwdCounts.values())
  if (mostRecentCount >= maxCount * 0.25) return latestCwd!
  return [...cwdCounts.entries()].find(([, c]) => c === maxCount)![0]
}

/**
 * List every project visible to the three frontends, dedup-ing between
 * auto-discovered entries in `~/.claude/projects/` and manually-added
 * ones in `~/.claude/project-config.json`.
 */
export async function listProjects(): Promise<ProjectInfo[]> {
  const config = await loadProjectConfig()
  const projects: ProjectInfo[] = []
  const seen = new Set<string>()

  try {
    await fs.access(PROJECTS_DIR)
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      seen.add(entry.name)
      const actualDir = await extractProjectDirectory(entry.name)
      if (!existsSync(actualDir)) continue
      const cfg = config[entry.name]
      const displayName = cfg?.displayName || await generateDisplayName(entry.name, actualDir)
      projects.push({
        name: entry.name,
        displayName,
        path: actualDir,
        manuallyAdded: Boolean(cfg?.manuallyAdded),
      })
    }
  } catch {}

  for (const [projectName, cfg] of Object.entries(config)) {
    if (seen.has(projectName)) continue
    if (!cfg.manuallyAdded) continue
    const actualDir = cfg.originalPath || await extractProjectDirectory(projectName)
    if (!existsSync(actualDir)) continue
    const displayName = cfg.displayName || await generateDisplayName(projectName, actualDir)
    projects.push({ name: projectName, displayName, path: actualDir, manuallyAdded: true })
  }

  projects.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return projects
}

export function formatProjectList(projects: ProjectInfo[]): string {
  if (projects.length === 0) {
    return '_No projects configured yet._ Use `/add-project <path>` to add one, or `/clone-repo <git-url>` to clone and add.'
  }
  const lines = ['| # | Name | Path |', '|---|---|---|']
  projects.forEach((p, i) => {
    lines.push(`| ${i + 1} | **${p.displayName}** | \`${p.path}\` |`)
  })
  return lines.join('\n')
}

/** Detect whether this CLI instance was spawned by the gateway (for per-user state writes). */
export function getGatewayContext(): { userId: string; platform: string } | null {
  const userId = process.env.CLAUDE_GATEWAY_USER_ID
  const platform = process.env.CLAUDE_GATEWAY_PLATFORM
  if (userId && platform) return { userId, platform }
  return null
}

export function gatewayStatePathFor(userId: string, platform: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, '_')
  return path.join(GATEWAY_STATE_DIR, `${safe(userId)}.${safe(platform)}.json`)
}
