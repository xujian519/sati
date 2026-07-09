import { describe, expect, it, vi } from 'vitest';
import { createWebSearchTool } from './webSearch.js';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

describe('web_search network behavior', () => {
  it('retries transient provider failures', async () => {
    const fetchImpl = vi.fn(async () => fetchImpl.mock.calls.length === 1
      ? jsonResponse({ error: 'temporary' }, 500)
      : jsonResponse({ results: [{ title: 'ok', url: 'https://example.test', content: 'snippet' }] }));
    const tool = createWebSearchTool({ provider: 'tavily', apiKey: 'tvly-test', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1000 });

    const result = await tool.execute({ query: 'hello' }, { env: {}, cwd: '/', projectRoot: '/', abortSignal: undefined } as any);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.data?.organic[0]?.title).toBe('ok');
  });

  it('turns request timeout into tool_timeout', async () => {
    const fetchImpl = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const tool = createWebSearchTool({ provider: 'tavily', apiKey: 'tvly-test', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1 });

    await expect(tool.execute({ query: 'hello' }, { env: {}, cwd: '/', projectRoot: '/', abortSignal: undefined } as any))
      .rejects.toMatchObject({ code: 'tool_timeout' });
  });

  it('turns network timeout errors into tool_timeout', async () => {
    const fetchImpl = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      setTimeout(() => reject(init?.signal?.reason), 0);
    }));
    const tool = createWebSearchTool({ provider: 'tavily', apiKey: 'tvly-test', fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 1 });

    await expect(tool.execute({ query: 'hello' }, { env: {}, cwd: '/', projectRoot: '/', abortSignal: undefined } as any))
      .rejects.toMatchObject({ code: 'tool_timeout' });
  });
});
