import express from 'express';
import fsPromises from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import { parse as parseYaml } from 'yaml';
import {
  buildDefaultPilotDeckConfig,
  configToYaml,
  getPilotDeckConfigPath,
  maskSecrets,
  parseConfigYaml,
  preserveMaskedSecrets,
  rawYamlToMaskedString,
  readPilotDeckConfigFile,
  validatePilotDeckConfig,
  writeRawPilotDeckYaml,
} from '../services/pilotdeckConfig.js';
import { reloadPilotDeckConfig } from '../services/pilotdeckConfigReloader.js';
import { suppressNextWatchEvent } from '../services/pilotdeckConfigWatcher.js';

const router = express.Router();

function serializeConfigResponse(record, reloadResult = null) {
  const validation = validatePilotDeckConfig(record.config);
  const maskedConfig = maskSecrets(record.config);
  return {
    exists: record.exists,
    path: record.configPath,
    raw: rawYamlToMaskedString(record.rawYaml),
    config: maskedConfig,
    validation: {
      valid: validation.valid,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    ...(reloadResult ? { reload: reloadResult } : {}),
  };
}

function broadcastConfigEvent(payload) {
  process.emit('pilotdeck:config-broadcast', payload);
}

router.get('/', (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    res.json(serializeConfigResponse(record));
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/validate', (req, res) => {
  try {
    const raw = typeof req.body?.raw === 'string' ? req.body.raw : '';
    const config = raw ? parseConfigYaml(raw) : req.body?.config;
    const validation = validatePilotDeckConfig(config);
    res.status(validation.valid ? 200 : 400).json(validation);
  } catch (error) {
    res.status(400).json({ valid: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] });
  }
});

router.put('/', async (req, res) => {
  try {
    const rawString = typeof req.body?.raw === 'string' ? req.body.raw : null;
    if (!rawString) {
      return res.status(400).json({ error: 'raw YAML is required' });
    }

    const incomingYaml = parseYaml(rawString);
    if (!incomingYaml || typeof incomingYaml !== 'object') {
      return res.status(400).json({ error: 'Invalid YAML' });
    }

    const diskRecord = readPilotDeckConfigFile();
    const restored = preserveMaskedSecrets(incomingYaml, diskRecord.rawYaml);

    suppressNextWatchEvent();
    const saved = await writeRawPilotDeckYaml(restored);
    const reloadResult = await reloadPilotDeckConfig(saved.config);
    const freshRecord = readPilotDeckConfigFile();
    const response = serializeConfigResponse(
      { exists: true, configPath: saved.configPath, ...freshRecord },
      reloadResult,
    );
    broadcastConfigEvent({ source: 'ui-save', ...response, timestamp: new Date().toISOString() });
    res.json(response);
  } catch (error) {
    if (error?.validation) {
      return res.status(400).json({ error: error.message, validation: error.validation });
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/reload', async (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    const validation = validatePilotDeckConfig(record.config);
    if (!validation.valid) {
      return res.status(400).json({ error: 'Invalid config', validation });
    }
    const reloadResult = await reloadPilotDeckConfig(record.config);
    const response = serializeConfigResponse(record, reloadResult);
    broadcastConfigEvent({ source: 'ui-reload', ...response, timestamp: new Date().toISOString() });
    res.json(response);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.get('/provider', (_req, res) => {
  try {
    const record = readPilotDeckConfigFile();
    const config = record.config;
    if (!config?.models?.providers) {
      return res.json({ exists: false, provider: null });
    }
    const providers = config.models.providers;
    const entries = config.models?.entries || {};
    const mainModel = config.agents?.main?.model;
    const configuredEntry = typeof mainModel === 'string'
      ? entries[mainModel]
      : null;
    const providerId = configuredEntry?.provider || Object.keys(providers)[0];
    if (!providerId) return res.json({ exists: false, provider: null });

    const provider = providers[providerId] || {};
    const defaultEntry = configuredEntry || entries[Object.keys(entries)[0]] || {};

    res.json({
      exists: true,
      provider: {
        type: provider.type || '',
        baseUrl: provider.baseUrl || '',
        apiKey: provider.apiKey || '',
        model: defaultEntry.name || '',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

router.post('/test-connection', async (req, res) => {
  const { providerType, baseUrl, apiKey, model } = req.body || {};
  if (!baseUrl || !apiKey || !model) {
    return res.status(400).json({ ok: false, error: 'baseUrl, apiKey, and model are required' });
  }

  const type = providerType || 'anthropic';
  const timeout = 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    let url;
    let fetchOptions;

    if (type === 'anthropic') {
      url = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;
      fetchOptions = {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    } else {
      const base = baseUrl.replace(/\/+$/, '');
      const hasV1 = /\/v1\/?$/i.test(base);
      url = hasV1 ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
      fetchOptions = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          messages: [{ role: 'user', content: 'Hi' }],
        }),
        signal: controller.signal,
      };
    }

    const response = await fetch(url, fetchOptions);
    clearTimeout(timer);

    if (response.ok) {
      return res.json({ ok: true, message: `Connected successfully — Model ${model} is available.` });
    }

    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = await response.json();
      if (body?.error?.message) detail = body.error.message;
      else if (body?.error?.type) detail = `${body.error.type}: ${body.error.message || ''}`;
    } catch { /* ignore parse errors */ }

    return res.json({ ok: false, error: `${detail}` });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      return res.json({ ok: false, error: `Connection timed out after ${timeout / 1000}s. Check your network and API URL.` });
    }
    return res.json({ ok: false, error: err.message || String(err) });
  }
});

router.post('/open', async (_req, res) => {
  const configPath = getPilotDeckConfigPath();
  try {
    await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
    try {
      await fsPromises.access(configPath);
    } catch {
      await fsPromises.writeFile(configPath, configToYaml(buildDefaultPilotDeckConfig()), 'utf8');
    }

    const command = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
        ? 'cmd'
        : 'xdg-open';
    const args = process.platform === 'darwin'
      ? ['-R', configPath]
      : process.platform === 'win32'
        ? ['/c', 'start', '', configPath]
        : [path.dirname(configPath)];
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.unref();
    res.json({ success: true, path: configPath });
  } catch (error) {
    res.json({ success: false, path: configPath, error: error instanceof Error ? error.message : String(error) });
  }
});

export default router;
