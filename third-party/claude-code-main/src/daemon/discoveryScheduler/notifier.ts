import { writeDiscoveryFireRequest } from '../discoveryRequests.js'
import { markDiscoveryFireStarted } from './state.js'
import type { AlwaysOnHeartbeat } from './types.js'

export async function notifyDiscoveryFire(
  projectRoot: string,
  heartbeat: AlwaysOnHeartbeat,
  now = new Date(),
): Promise<void> {
  await writeDiscoveryFireRequest(projectRoot, heartbeat, now)
  await markDiscoveryFireStarted(projectRoot, now)
}
