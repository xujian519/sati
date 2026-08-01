import { describe, expect, it, vi } from "vitest";
import { SmoothTextStream } from "./streamSmoother";

function createManualFrameScheduler(onFrame?: () => void) {
  let nextId = 1;
  const queue: Array<{ id: number; callback: () => void; cancelled: boolean }> = [];

  return {
    scheduleFrame(callback: () => void): number {
      const id = nextId;
      nextId += 1;
      queue.push({ id, callback, cancelled: false });
      return id;
    },
    cancelFrame(id: number) {
      const item = queue.find(entry => entry.id === id);
      if (item) item.cancelled = true;
    },
    runNext() {
      const item = queue.shift();
      if (item && !item.cancelled) {
        onFrame?.();
        item.callback();
      }
    },
    drain(limit = 80) {
      let count = 0;
      while (queue.length > 0 && count < limit) {
        this.runNext();
        count += 1;
      }
      return count;
    },
    get size() {
      return queue.filter(item => !item.cancelled).length;
    },
  };
}

describe("SmoothTextStream", () => {
  it("renders a large chunk over many bounded frame updates", () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    const text = "abcdefghijklmnopqrstuvwxyz ".repeat(8);
    const stream = new SmoothTextStream({
      emit: content => emitted.push(content),
      scheduleFrame: callback => scheduler.scheduleFrame(callback),
      cancelFrame: handle => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append(text);

    // 首块由下一帧异步发出（append 不立即同步 emit）。
    expect(emitted.length).toBe(0);
    scheduler.runNext();

    expect(emitted.length).toBe(1);
    expect(emitted[0].length).toBeGreaterThan(0);
    expect(emitted[0].length).toBeLessThan(text.length);
    expect(stream.getSnapshot().targetLength).toBe(text.length);

    // 216 chars / 2 chars-per-frame = 108 帧，超过默认 drain 上限。
    scheduler.drain(120);

    expect(emitted[emitted.length - 1]).toBe(text);
    expect(stream.getSnapshot().renderedLength).toBe(text.length);
  });

  it("keeps a steady rendering rate while content is buffered", () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const stream = new SmoothTextStream({
      emit: () => {},
      scheduleFrame: callback => scheduler.scheduleFrame(callback),
      cancelFrame: handle => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append("abcd");
    now += 40;
    stream.append("x".repeat(80));

    const snapshot = stream.getSnapshot();
    expect(snapshot.pendingChars).toBeGreaterThan(0);
    // 速率恒定（动画已移除），pending 内容稍后逐帧渲染。
    scheduler.drain(60);
    expect(stream.getSnapshot().renderedLength).toBe(84);
  });

  it("flushes all buffered content and finalizes immediately", () => {
    let now = 0;
    const scheduler = createManualFrameScheduler(() => {
      now += 33;
    });
    const emitted: string[] = [];
    let finalized = 0;
    const stream = new SmoothTextStream({
      emit: content => emitted.push(content),
      finalize: () => {
        finalized += 1;
      },
      scheduleFrame: callback => scheduler.scheduleFrame(callback),
      cancelFrame: handle => scheduler.cancelFrame(handle),
      now: () => now,
    });

    stream.append("streaming output");
    stream.flush(true);

    expect(emitted.at(-1)).toBe("streaming output");
    expect(finalized).toBe(1);
    expect(stream.getSnapshot().targetLength).toBe(0);
    expect(stream.getSnapshot().renderedLength).toBe(0);
    expect(scheduler.size).toBe(0);
  });

  it("falls back when requestAnimationFrame does not run promptly", () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi.fn(() => 1);
    const clearTimeoutSpy = vi.fn();
    vi.stubGlobal("window", {
      requestAnimationFrame: requestAnimationFrameSpy,
      cancelAnimationFrame: vi.fn(),
      setTimeout: globalThis.setTimeout,
      clearTimeout: clearTimeoutSpy,
    });
    const emitted: string[] = [];

    try {
      const stream = new SmoothTextStream({
        emit: content => emitted.push(content),
        fallbackFrameMs: 10,
      });

      stream.append("abcdefghijklmnopqrstuvwxyz ".repeat(4));

      // 首块不立即同步发出，等待 fallback 定时器推动首帧渲染。
      expect(emitted.length).toBe(0);
      vi.advanceTimersByTime(10);

      expect(emitted.length).toBeGreaterThan(0);
      expect(clearTimeoutSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });
});
