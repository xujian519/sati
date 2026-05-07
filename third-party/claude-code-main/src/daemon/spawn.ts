import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { isInBundledMode } from '../utils/bundledMode.js'

function getSourceRootDir(): string {
  const sourceFilePath = fileURLToPath(import.meta.url)
  return resolve(dirname(sourceFilePath), '..')
}

function getSourcePreloadPath(): string {
  return resolve(getSourceRootDir(), '../preload.ts')
}

function getSourceImportPath(relativePathFromSrc: string): string {
  return resolve(getSourceRootDir(), relativePathFromSrc)
}

function buildSourceEvalArgs(code: string): string[] {
  return ['--preload', getSourcePreloadPath(), '-e', code]
}

export function getDaemonCommandArgs(): string[] {
  if (isInBundledMode()) {
    return ['daemon', 'serve']
  }

  const daemonMainPath = getSourceImportPath('daemon/main.ts')
  return buildSourceEvalArgs(
    `const { daemonMain } = await import(${JSON.stringify(daemonMainPath)}); await daemonMain(['serve'])`,
  )
}

export function getDaemonWorkerCommandArgs(spec: string): string[] {
  if (isInBundledMode()) {
    return ['--daemon-worker', spec]
  }

  const workerRegistryPath = getSourceImportPath('daemon/workerRegistry.ts')
  return buildSourceEvalArgs(
    `const { runDaemonWorker } = await import(${JSON.stringify(workerRegistryPath)}); await runDaemonWorker(${JSON.stringify(spec)})`,
  )
}
