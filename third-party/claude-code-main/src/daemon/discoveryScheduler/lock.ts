import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname } from 'path'
import { getAlwaysOnDiscoveryLockPath } from '../../utils/alwaysOnPaths.js'

export async function acquireDiscoveryLock(projectRoot: string): Promise<boolean> {
  const path = getAlwaysOnDiscoveryLockPath(projectRoot)
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(
      path,
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
      { encoding: 'utf-8', flag: 'wx' },
    )
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      return false
    }
    throw error
  }
}

export async function releaseDiscoveryLock(projectRoot: string): Promise<void> {
  await rm(getAlwaysOnDiscoveryLockPath(projectRoot), { force: true })
}
