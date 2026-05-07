import { mkdir, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import {
  getCronDaemonDiscoveryRequestPath,
  getCronDaemonDiscoveryRequestsDir,
} from './paths.js'
import type { AlwaysOnHeartbeat, DiscoveryFireRequest } from './discoveryScheduler/types.js'

export async function writeDiscoveryFireRequest(
  projectRoot: string,
  heartbeat: AlwaysOnHeartbeat,
  now = new Date(),
): Promise<DiscoveryFireRequest> {
  const request: DiscoveryFireRequest = {
    schemaVersion: 1,
    requestId: randomUUID(),
    projectRoot,
    targetWriterKind: heartbeat.writerKind,
    targetWriterId: heartbeat.writerId,
    createdAt: now.toISOString(),
  }

  await mkdir(getCronDaemonDiscoveryRequestsDir(), { recursive: true })
  await writeFile(
    getCronDaemonDiscoveryRequestPath(request.requestId),
    JSON.stringify(request, null, 2),
    'utf-8',
  )
  return request
}
