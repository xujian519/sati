import { mkdir, readFile, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { getCronDaemonProjectsPath } from './paths.js'
import { safeParseJSON } from '../utils/json.js'
import { jsonStringify } from '../utils/slowOperations.js'

type ProjectRegistryFile = {
  projectRoots: string[]
}

export class CronDaemonProjectRegistry {
  private readonly projectRoots = new Set<string>()
  private loaded = false

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = await readFile(getCronDaemonProjectsPath(), 'utf-8')
      const parsed = safeParseJSON(raw, false) as
        | Partial<ProjectRegistryFile>
        | null
      if (!parsed || !Array.isArray(parsed.projectRoots)) {
        return
      }
      for (const projectRoot of parsed.projectRoots) {
        if (typeof projectRoot === 'string' && projectRoot.length > 0) {
          this.projectRoots.add(resolve(projectRoot))
        }
      }
    } catch {
      // Missing or malformed registry should not block daemon startup.
    }
  }

  list(): string[] {
    return [...this.projectRoots]
  }

  async remember(projectRoot: string): Promise<void> {
    await this.load()
    const normalized = resolve(projectRoot)
    if (this.projectRoots.has(normalized)) {
      return
    }
    this.projectRoots.add(normalized)
    await this.flush()
  }

  private async flush(): Promise<void> {
    const path = getCronDaemonProjectsPath()
    await mkdir(dirname(path), { recursive: true })
    await writeFile(
      path,
      jsonStringify({ projectRoots: this.list() }, null, 2) + '\n',
      'utf-8',
    )
  }
}
