import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('config test-connection route', () => {
  it('uses protocol-versioned chat completions when the root base URL works', async () => {
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

  it('falls back to unversioned chat completions when protocol-versioned probing misses', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/chat/completions') {
        return jsonResponse({ error: { message: 'not found' } }, { ok: false, status: 404, statusText: 'Not Found' });
      }
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
    expect(calls).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/chat/completions',
    ]);
  });

  it('falls back to unversioned chat completions when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.openai.com/v1/chat/completions') {
        return jsonResponse({ ok: true });
      }
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
    expect(calls).toEqual([
      'https://api.openai.com/v1/chat/completions',
      'https://api.openai.com/chat/completions',
    ]);
  });

  it('falls back to unversioned messages for Anthropic when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://api.anthropic.com/v1/messages') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ type: 'message', content: [{ type: 'text', text: 'ok' }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        apiKey: 'sk-test',
        model: 'claude-test',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://api.anthropic.com/v1/messages',
      'https://api.anthropic.com/messages',
    ]);
  });

  it('falls back to unversioned Gemini endpoint when protocol-versioned probing returns unexpected JSON', async () => {
    const calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url) => {
      calls.push(String(url));
      if (String(url) === 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent') {
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
    }));

    const { request } = await createConfigApp();
    const data = await request('/api/config/test-connection', {
      method: 'POST',
      body: JSON.stringify({
        providerType: 'google',
        baseUrl: 'https://generativelanguage.googleapis.com',
        apiKey: 'sk-test',
        model: 'gemini-pro',
      }),
    });

    expect(data.ok).toBe(true);
    expect(calls).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
      'https://generativelanguage.googleapis.com/models/gemini-pro:generateContent',
    ]);
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

  it('accepts full OpenAI-compatible endpoint URLs', async () => {
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
        baseUrl: 'https://api.openai.com/v1/chat/completions',
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

function jsonResponse(payload, overrides = {}) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    ...overrides,
    text: async () => JSON.stringify(payload),
  };
}
