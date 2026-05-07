import type { CronDaemonClientKind, CronDaemonClientLease } from './types.js'

export type ClientLeaseSnapshot = CronDaemonClientLease & {
  expiresAt: number
}

export class ClientLeaseRegistry {
  private readonly leases = new Map<string, ClientLeaseSnapshot>()
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly ttlMs = 30_000,
    private readonly sweepIntervalMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  start(onChanged: () => void): void {
    if (this.sweepTimer) return
    this.sweepTimer = setInterval(() => {
      if (this.sweepExpired() > 0) {
        onChanged()
      }
    }, this.sweepIntervalMs)
    this.sweepTimer.unref()
  }

  stop(): void {
    if (!this.sweepTimer) return
    clearInterval(this.sweepTimer)
    this.sweepTimer = null
  }

  upsert(input: {
    clientId: string
    clientKind: CronDaemonClientKind
    processId?: number
    projectRoots?: string[]
  }): ClientLeaseSnapshot {
    const now = this.now()
    const lease: ClientLeaseSnapshot = {
      clientId: input.clientId,
      clientKind: input.clientKind,
      ...(typeof input.processId === 'number' ? { processId: input.processId } : {}),
      projectRoots: input.projectRoots ?? [],
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.leases.set(input.clientId, lease)
    return lease
  }

  heartbeat(clientId: string, projectRoots?: string[]): ClientLeaseSnapshot | null {
    const existing = this.leases.get(clientId)
    if (!existing) {
      return null
    }

    const now = this.now()
    const next: ClientLeaseSnapshot = {
      ...existing,
      ...(projectRoots ? { projectRoots } : {}),
      lastSeenAt: now,
      expiresAt: now + this.ttlMs,
    }
    this.leases.set(clientId, next)
    return next
  }

  unregister(clientId: string): boolean {
    return this.leases.delete(clientId)
  }

  sweepExpired(): number {
    const now = this.now()
    let removed = 0
    for (const [clientId, lease] of this.leases) {
      if (lease.expiresAt <= now) {
        this.leases.delete(clientId)
        removed += 1
      }
    }
    return removed
  }

  hasFreshClients(): boolean {
    this.sweepExpired()
    return this.leases.size > 0
  }

  list(): ClientLeaseSnapshot[] {
    this.sweepExpired()
    return [...this.leases.values()]
  }

  count(): number {
    this.sweepExpired()
    return this.leases.size
  }
}
