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
  // 防御（质量审阅 C1）：tail 链经归纳证明永不 reject（gate 仅 resolve、previous 为上一 tail），
  // 但未来若引入 reject 源，裸 await previous 会跳过 finally（release 不调用）→ 队列残留、后续调用者永久挂起。
  // .catch 吞掉毒化链，锁自愈：当前调用者照常执行。
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === tail) queues.delete(key);
  }
}
