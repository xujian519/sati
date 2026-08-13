import { describe, expect, it, vi } from "vitest";
import { createClawhubPathCache } from "./clawhub.js";

describe("clawhub path cache", () => {
  it("reuses a positive resolution across calls", async () => {
    const resolve = vi.fn().mockResolvedValue("/opt/clawhub/bin/clawhub");
    const cache = createClawhubPathCache(resolve);
    const first = await cache.get();
    const second = await cache.get();
    expect(second).toBe(first);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("does not cache a negative result (mid-session install is picked up)", async () => {
    const resolve = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/opt/clawhub/bin/clawhub");
    const cache = createClawhubPathCache(resolve);
    await expect(cache.get()).resolves.toBe(null);
    await expect(cache.get()).resolves.toBe("/opt/clawhub/bin/clawhub");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("re-resolves after reset", async () => {
    const resolve = vi.fn().mockResolvedValueOnce("/opt/old/clawhub").mockResolvedValueOnce("/opt/new/clawhub");
    const cache = createClawhubPathCache(resolve);
    await expect(cache.get()).resolves.toBe("/opt/old/clawhub");
    cache.reset();
    await expect(cache.get()).resolves.toBe("/opt/new/clawhub");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("bypasses the cache when options are passed", async () => {
    const resolve = vi.fn().mockResolvedValue("/opt/clawhub/bin/clawhub");
    const cache = createClawhubPathCache(resolve);
    await cache.get({ env: { PATH: "/none" } });
    await cache.get({ env: { PATH: "/none" } });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});
