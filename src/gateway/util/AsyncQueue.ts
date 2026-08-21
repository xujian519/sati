/**
 * Minimal single-producer-multi-(or single-)consumer FIFO queue with an
 * async iterator surface. Used by `InProcessGateway.submitTurn` to fan-in
 * events from two sources:
 *   1. The agent session's event stream (mapped through `mapAgentEvent`).
 *   2. The elicitation channel's downstream emits (B1).
 *
 * Closing the queue terminates the iterator; pending `dequeue()` resolves
 * to `{ done: true }`. Pushing after close is a no-op.
 */
export class AsyncQueue<T> {
  private readonly buffer: T[] = [];
  private readonly waiters: Array<{ resolve(value: IteratorResult<T>): void }> = [];
  private closed = false;

  enqueue(value: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve({ value, done: false });
      return;
    }
    this.buffer.push(value);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter = this.waiters.shift();
    while (waiter) {
      waiter.resolve({ value: undefined as unknown as T, done: true });
      waiter = this.waiters.shift();
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        const item = this.buffer.shift();
        if (item !== undefined) {
          return Promise.resolve({ value: item, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined as unknown as T, done: true });
        }
        return new Promise<IteratorResult<T>>(resolve => {
          this.waiters.push({ resolve });
        });
      },
    };
  }
}
