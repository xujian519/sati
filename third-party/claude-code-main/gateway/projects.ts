/**
 * Project discovery for the gateway.
 *
 * Lists projects from ~/.claude/projects/ and ~/.claude/project-config.json,
 * resolving each to its real filesystem path. Ported (simplified) from
 * ui/server/projects.js.
 */

import { promises as fs } from 'node:fs'
import fsSync from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import os from 'node:os'

export interface ProjectInfo {
  name: string
  displayName: string
  path: string
}

const directoryCache = new Map<string, string>()

async function loadProjectConfig(): Promise<Record<string, any>> {
  const configPath = path.join(os.homedir(), '.claude', 'project-config.json')
  try {
    const data = await fs.readFile(configPath, 'utf8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

async function generateDisplayName(projectName: string, projectDir: string | null): Promise<string> {
  const projectPath = projectDir || projectName.replace(/-/g, '/')

  try {
    const pkg = JSON.parse(await fs.readFile(path.join(projectPath, 'package.json'), 'utf8'))
    if (pkg.name) return pkg.name
  } catch {}

  if (projectPath.startsWith('/')) {
    const parts = projectPath.split('/').filter(Boolean)
    return parts[parts.length - 1] || projectPath
  }
  return projectPath
}

async function extractProjectDirectory(projectName: string): Promise<string> {
  if (directoryCache.has(projectName)) {
    return directoryCache.get(projectName)!
  }

  const config = await loadProjectConfig()
  if (config[projectName]?.originalPath) {
    const p = config[projectName].originalPath as string
    directoryCache.set(projectName, p)
    return p
  }

  const projectDir = path.join(os.homedir(), '.claude', 'projects', projectName)
  const cwdCounts = new Map<string, number>()
  let latestTimestamp = 0
  let latestCwd: string | null = null

  try {
    await fs.access(projectDir)
    const files = await fs.readdir(projectDir)
    const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

    if (jsonlFiles.length === 0) {
      const fallback = projectName.replace(/-/g, '/')
      directoryCache.set(projectName, fallback)
      return fallback
    }

    for (const file of jsonlFiles) {
      const filePath = path.join(projectDir, file)
      const stream = fsSync.createReadStream(filePath)
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

    let result: string
    if (cwdCounts.size === 0) {
      result = projectName.replace(/-/g, '/')
    } else if (cwdCounts.size === 1) {
      result = Array.from(cwdCounts.keys())[0]
    } else {
      const mostRecentCount = cwdCounts.get(latestCwd!) || 0
      const maxCount = Math.max(...cwdCounts.values())
      if (mostRecentCount >= maxCount * 0.25) {
        result = latestCwd!
      } else {
        result = Array.from(cwdCounts.entries()).find(([, c]) => c === maxCount)![0]
      }
    }

    directoryCache.set(projectName, result)
    return result
  } catch {
    const fallback = projectName.replace(/-/g, '/')
    directoryCache.set(projectName, fallback)
    return fallback
  }
}

export async function listProjects(): Promise<ProjectInfo[]> {
  const claudeDir = path.join(os.homedir(), '.claude', 'projects')
  const config = await loadProjectConfig()
  const projects: ProjectInfo[] = []
  const seen = new Set<string>()

  try {
    await fs.access(claudeDir)
    const entries = await fs.readdir(claudeDir, { withFileTypes: true })
    const dirs = entries.filter(e => e.isDirectory())

    for (const entry of dirs) {
      seen.add(entry.name)
      const actualDir = await extractProjectDirectory(entry.name)
      try {
        await fs.access(actualDir)
      } catch {
        continue
      }
      const customName = config[entry.name]?.displayName as string | undefined
      const displayName = customName || await generateDisplayName(entry.name, actualDir)
      projects.push({ name: entry.name, displayName, path: actualDir })
    }
  } catch {}

  for (const [projectName, projectConfig] of Object.entries(config)) {
    if (seen.has(projectName)) continue
    if (!(projectConfig as any).manuallyAdded) continue

    const actualDir = (projectConfig as any).originalPath as string | undefined
      || await extractProjectDirectory(projectName)
    try {
      await fs.access(actualDir)
    } catch {
      continue
    }
    const displayName = (projectConfig as any).displayName as string | undefined
      || await generateDisplayName(projectName, actualDir)
    projects.push({ name: projectName, displayName, path: actualDir })
  }

  projects.sort((a, b) => a.displayName.localeCompare(b.displayName))
  return projects
}

export function formatProjectListText(projects: ProjectInfo[]): string {
  if (projects.length === 0) {
    return '暂无可用项目。\n请先用 Claude Code CLI 打开一个项目，或在 ~/.claude/project-config.json 中手动添加。'
  }

  const lines = ['📂 项目列表：', '']
  for (let i = 0; i < projects.length; i++) {
    lines.push(`${i + 1}. ${projects[i].displayName}`)
    lines.push(`   ${projects[i].path}`)
  }
  lines.push('', '回复编号选择项目')
  return lines.join('\n')
}

export function buildFeishuProjectCard(projects: ProjectInfo[]): Record<string, unknown> {
  if (projects.length === 0) {
    return {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: 'plain_text', content: '📂 项目选择' },
        template: 'blue',
      },
      elements: [
        {
          tag: 'div',
          text: {
            tag: 'plain_text',
            content: '暂无可用项目。请先用 Claude Code CLI 打开一个项目。',
          },
        },
      ],
    }
  }

  const elements: Record<string, unknown>[] = []

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i]
    elements.push({
      tag: 'action',
      actions: [
        {
          tag: 'button',
          text: { tag: 'plain_text', content: p.displayName },
          type: 'primary',
          value: JSON.stringify({ action: 'select_project', index: i, name: p.name, path: p.path }),
        },
      ],
    })
    elements.push({
      tag: 'note',
      elements: [{ tag: 'plain_text', content: p.path }],
    })
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: '📂 选择项目' },
      template: 'blue',
    },
    elements,
  }
}
