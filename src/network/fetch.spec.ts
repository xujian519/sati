import { describe, expect, it, vi } from 'vitest';
import { NetworkFetchError, networkFetch, normalizeNetworkError, jitteredBackoff } from './fetch.js';

function response(status: number, headers: Record<string, string> = {}): Response {
  return new Response('{}', { status, headers });
}

describe('networkFetch', () => {
  it('retries retryable status responses and then succeeds', async () => {
    const fetchImpl = vi.fn(async () => fetchImpl.mock.calls.length === 1 ? response(500) : response(200));

    const result = await networkFetch('https://example.test', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });

    expect(result.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('uses retry-after when calculating retry delay', () => {
    expect(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 10_000 }, '2')).toBe(2000);
  });

  it('caps retry-after delays with maxDelayMs', () => {
    expect(jitteredBackoff(0, { baseDelayMs: 1, maxDelayMs: 5_000 }, '3600')).toBe(5000);
  });

  it('normalizes DNS and reset errors', () => {
    expect(normalizeNetworkError(Object.assign(new Error('getaddrinfo ENOTFOUND api.test'), { code: 'ENOTFOUND' })).code).toBe('network_dns_error');
    expect(normalizeNetworkError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })).code).toBe('network_connection_reset');
  });

  it('times out requests', async () => {
    const fetchImpl = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));

    await expect(networkFetch('https://example.test', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1,
    })).rejects.toMatchObject({ code: 'network_timeout' });
  });

  it('honors init.signal abort reasons without options.signal', async () => {
    const controller = new AbortController();
    const reason = new NetworkFetchError('network_timeout', 'outer timeout');
    const fetchImpl = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(reason);
    }));

    await expect(networkFetch('https://example.test', { signal: controller.signal }, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })).rejects.toMatchObject({ code: 'network_timeout' });
  });

  it('preserves parent NetworkFetchError reasons passed through options.signal', async () => {
    const controller = new AbortController();
    const reason = new NetworkFetchError('network_timeout', 'configured timeout');
    const fetchImpl = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      controller.abort(reason);
    }));

    await expect(networkFetch('https://example.test', {}, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: 'network_timeout' });
  });
});
