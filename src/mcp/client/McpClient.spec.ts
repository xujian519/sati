import { describe, expect, it, vi } from 'vitest';

const streamableHttpTransports: Array<{ url: URL; opts: { fetch?: typeof fetch } }> = [];
const networkFetchMock = vi.hoisted(() => vi.fn(async () => new Response('{}')));

vi.mock('../../network/fetch.js', () => ({
  networkFetch: networkFetchMock,
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class StreamableHTTPClientTransport {
    constructor(url: URL, opts: { fetch?: typeof fetch }) {
      streamableHttpTransports.push({ url, opts });
    }
  },
}));

import { McpClient } from './McpClient.js';

describe('McpClient transports', () => {
  it('keeps stdio clients idle before connection', () => {
    const client = new McpClient({ id: 'stdio-test', transport: 'stdio', command: 'node' });
    expect(client.getStatus()).toBe('idle');
  });

  it('constructs streamable_http transport without requiring stdio fields', () => {
    const client = new McpClient({ id: 'http-test', transport: 'streamable_http', url: 'https://mcp.example.test/mcp' });
    expect(client.getStatus()).toBe('idle');
  });

  it('routes streamable_http fetches through networkFetch with bounded timeouts', async () => {
    const client = new McpClient(
      { id: 'http-test', transport: 'streamable_http', url: 'https://mcp.example.test/mcp' },
      { callTimeoutMs: 12_345, handshakeTimeoutMs: 2_345 },
    );
    (client as unknown as { buildTransport(): unknown }).buildTransport();

    const transportFetch = streamableHttpTransports.at(-1)?.opts.fetch;
    expect(transportFetch).toBeTypeOf('function');

    await transportFetch?.('https://mcp.example.test/mcp', { method: 'GET' });
    expect(networkFetchMock).toHaveBeenLastCalledWith(
      'https://mcp.example.test/mcp',
      { method: 'GET' },
      expect.objectContaining({ timeoutMs: 2_345 }),
    );

    await transportFetch?.('https://mcp.example.test/mcp', { method: 'POST' });
    expect(networkFetchMock).toHaveBeenLastCalledWith(
      'https://mcp.example.test/mcp',
      { method: 'POST' },
      expect.objectContaining({ timeoutMs: 12_345 }),
    );
  });
});
