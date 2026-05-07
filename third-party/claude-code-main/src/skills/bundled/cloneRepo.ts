import { spawn } from 'node:child_process'
import { existsSync, promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { registerBundledSkill } from '../bundledSkills.js'
import {
  encodeProjectName,
  expandHome,
  loadProjectConfig,
  parseArgs,
  saveProjectConfig,
} from './projectsShared.js'

function defaultParentDir(): string {
  return process.env.CLAUDE_CLONE_PARENT_DIR
    ? expandHome(process.env.CLAUDE_CLONE_PARENT_DIR)
    : path.join(homedir(), 'projects')
}

function inferRepoName(url: string): string {
  const last = url.split('/').pop() || 'repo'
  return last.replace(/\.git$/, '')
}

/** Run `git clone --progress` and stream output to stderr so the user sees it in the TUI. */
function runGitClone(url: string, target: string): Promise<{ code: number; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn('git', ['clone', '--progress', url, target], {
      stdio: ['ignore', 'inherit', 'pipe'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8')
      stderr += text
      // Echo to the user's terminal too (git clone --progress writes to stderr).
      process.stderr.write(text)
    })
    child.on('error', err => resolve({ code: 1, stderr: String(err) }))
    child.on('close', code => resolve({ code: code ?? 1, stderr }))
  })
}

async function registerProject(absolutePath: string, displayName: string): Promise<{ alreadyRegistered: boolean; key: string }> {
  const projectName = encodeProjectName(absolutePath)
  const config = await loadProjectConfig()
  if (config[projectName]) {
    return { alreadyRegistered: true, key: projectName }
  }
  config[projectName] = {
    manuallyAdded: true,
    originalPath: absolutePath,
    displayName,
  }
  await saveProjectConfig(config)
  return { alreadyRegistered: false, key: projectName }
}

async function performClone(rawArgs: string): Promise<string> {
  const tokens = parseArgs(rawArgs)
  if (tokens.length === 0) {
    return [
      '**Missing git URL.** Usage: `/clone-repo <git-url> [parentDir] [name]`.',
      '',
      'Examples:',
      '- `/clone-repo https://github.com/anthropic/claude-code`',
      '- `/clone-repo git@github.com:me/foo.git ~/work foo-main`',
    ].join('\n')
  }

  const [url, rawParent, rawName] = tokens
  const parent = rawParent ? expandHome(rawParent) : defaultParentDir()
  const name = rawName || inferRepoName(url)
  const target = path.join(parent, name)

  if (existsSync(target)) {
    const entries = await fsp.readdir(target).catch(() => [])
    if (entries.length > 0) {
      return `**Target already exists and is non-empty:** \`${target}\`. Pick a different name or remove the directory first.`
    }
  }

  await fsp.mkdir(parent, { recursive: true })

  const { code, stderr } = await runGitClone(url, target)
  if (code !== 0) {
    const tail = stderr.trim().split('\n').slice(-10).join('\n')
    return [
      `**Clone failed** (exit code ${code}). git stderr:`,
      '',
      '```',
      tail || '(no output)',
      '```',
    ].join('\n')
  }

  const { alreadyRegistered, key } = await registerProject(target, name)
  const regLine = alreadyRegistered
    ? `_(Project already registered under key \`${key}\`.)_`
    : `Registered as project \`${key}\`.`

  return [
    `**Cloned** \`${url}\` → \`${target}\`.`,
    regLine,
    '',
    `Switch to it with \`/switch-project ${key}\` (gateway/IM), or open it in the TUI by running \`cd ${target}\`.`,
  ].join('\n')
}

export function registerCloneRepoSkill(): void {
  registerBundledSkill({
    name: 'clone-repo',
    description:
      'Clone a git repository and register the clone as a Claude Code project so it shows up in the TUI, gateway, and claudecodeui.',
    argumentHint: '<git-url> [parentDir] [name]',
    userInvocable: true,
    allowedTools: [],
    async getPromptForCommand(args) {
      const report = await performClone(args ?? '')
      return [
        {
          type: 'text',
          text: [
            `The user ran \`/clone-repo ${args}\`. The skill performed the clone and project registration directly — relay the result without running any tools.`,
            '',
            '## Result',
            '',
            report,
            '',
            'Respond with this result (you may tighten the wording). Do not run any tools.',
          ].join('\n'),
        },
      ]
    },
  })
}
