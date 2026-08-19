/**
 * per-team 内存锁：promise 链串行化（dsh scheduler serializeMember 同构）。
 * Sati 单 gateway 进程常驻——锁保证同团队内 read-modify-write 原子性，
 * SQLite 事务兜底持久层一致性（进程崩溃安全由冷恢复负责）。
 */
const queues = new Map<string, Promise<unknown>>();

export async function withTeamLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  queues.set(key, tail);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
