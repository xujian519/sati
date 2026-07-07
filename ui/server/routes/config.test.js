import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('config test-connection route', () => {
  it('uses /v1/chat/completions for root OpenAI base URLs and requires text', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('does not duplicate existing version paths', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual(['https://api.openai.com/v1/chat/completions']);
  });

  it('fails when the provider returns no chat text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ choices: [{ message: { content: '' } }] })));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai',
        baseUrl: 'https://api.openai.com',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(false);
    expect(data.error).toContain('did not produce any chat text');
  });

  it('accepts Responses API output_text content parts', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      object: 'response',
      output: [{
        type: 'message',
        content: [{ type: 'output_text', output_text: 'ok' }],
      }],
    })));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-test',
      }),
    });

    expect(data.ok).toBe(true);
  });
});

async function createConfigApp() {
  vi.doMock('../services/pilotdeckConfigWatcher.js', () => ({
    suppressNextWatchEvent: vi.fn(),
  }));
  vi.doMock('../services/pilotdeckConfigReloader.js', () => ({
    reloadPilotDeckConfig: vi.fn(async () => undefined),
  }));
  vi.doMock('../services/pilotdeckConfig.js', async () => {
    const actual = await vi.importActual('../services/pilotdeckConfig.js');
    return {
      ...actual,
      readPilotDeckConfigFile: vi.fn(() => ({ exists: false, configPath: '', config: {}, rawYaml: {} })),
      writePilotDeckConfig: vi.fn(),
      writeRawPilotDeckYaml: vi.fn(),
    };
  });
  vi.doMock('../pilotdeck-bridge.js', () => ({
    getPilotDeckGateway: vi.fn(async () => ({ reloadConfig: vi.fn(async () => undefined) })),
  }));

  const { default: configRoutes } = await import('./config.js');
  const app = express();
  app.use(express.json());
  app.use('/api/config', configRoutes);

  return {
    request: (path, init) => requestJson(app, path, init),
  };
}

async function requestJson(app, path, init = {}) {
  const server = app.listen(0);
  try {
    const { port } = server.address();
    const response = await nativeFetch(`http://127.0.0.1:${port}${path}`, {
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
      ...init,
    });
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonResponse(payload) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(payload),
  };
}
