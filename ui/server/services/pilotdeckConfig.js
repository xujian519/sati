import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Source of truth: ~/.pilotdeck/pilotdeck.yaml. The gateway's `model` /
// `agent` sections are reused so the UI's provider picker and the
// gateway runtime agree on the active model. Web-UI-only settings live
// under the `webui` top-level key (whitelisted in src/pilot loader so
// no diagnostic is emitted).
const CONFIG_VERSION = 1;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), '.pilotdeck', 'pilotdeck.yaml');
const MASK = '********';

const SECRET_KEY_RE = /(api[_-]?key|token|secret|password|auth[_-]?token|access[_-]?token|bot[_-]?token|app[_-]?token|encoding[_-]?aes[_-]?key)$/i;
const SECRET_EXACT_KEYS = new Set(['key', 'apiKey', 'api_key', 'authToken', 'accessToken']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripTrailingSlash(value) {
  return normalizeString(value).replace(/\/+$/, '');
}

function providerEndpointForType(provider) {
  const baseUrl = stripTrailingSlash(provider?.baseUrl);
  const type = normalizeString(provider?.type) || 'openai-chat';
  if (!baseUrl) return '';
  if (type === 'openai-responses') return `${baseUrl}/responses`;
  if (type === 'anthropic') return `${baseUrl}/v1/messages`;
  if (type === 'openai-chat' || type === 'litellm') return `${baseUrl}/chat/completions`;
  return `${baseUrl}/chat/completions`;
}

function deepMerge(base, override) {
  if (!isRecord(base)) return clone(override);
  const output = clone(base);
  if (!isRecord(override)) return output;
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isRecord(value) && isRecord(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

// ─── ui-internal schema ──────────────────────────────────────────────────────
// Kept compatible with the previous EdgeClaw shape so existing consumers
// (memoryService, routes/config, routes/memory, settings UI) stay unchanged.
// channels / IM-gateway / CCR router segments were stripped — they had no
// remaining consumer in the codebase after the PilotDeck migration.

export function buildDefaultPilotDeckConfig() {
  return {
    version: CONFIG_VERSION,
    runtime: {
      host: '0.0.0.0',
      serverPort: 3001,
      vitePort: 5173,
      proxyPort: 18080,
      contextWindow: 160000,
      apiTimeoutMs: 120000,
      httpsProxy: '',
      databasePath: path.join(os.homedir(), '.pilotdeck', 'auth.db'),
      workspacesRoot: os.homedir(),
    },
    models: {
      providers: {},
      entries: {},
    },
    agents: {
      main: {
        model: '',
        params: {},
      },
      subagents: {
        default: 'inherit',
        params: {},
      },
    },
    memory: {
      enabled: true,
      model: 'inherit',
      params: {},
      reasoningMode: 'answer_first',
      autoIndexIntervalMinutes: 30,
      autoDreamIntervalMinutes: 60,
      captureStrategy: 'last_turn',
      includeAssistant: true,
      maxMessageChars: 6000,
      heartbeatBatchSize: 30,
    },
  };
}

// ─── pilotdeck.yaml ↔ ui-internal schema adapter ─────────────────────────────

function protocolToInternalType(protocol) {
  switch (normalizeString(protocol).toLowerCase()) {
    case 'openai':
    case 'openai-chat':
    case 'chat': return 'openai-chat';
    case 'anthropic': return 'anthropic';
    case 'openai-responses':
    case 'responses': return 'openai-responses';
    case 'litellm': return 'litellm';
    default: return 'openai-chat';
  }
}

function internalTypeToProtocol(type) {
  switch (normalizeString(type).toLowerCase()) {
    case 'openai-chat': return 'openai';
    case 'anthropic': return 'anthropic';
    case 'openai-responses': return 'openai-responses';
    case 'litellm': return 'litellm';
    default: return 'openai';
  }
}

function adaptPilotDeckYamlToInternal(rawYaml) {
  const yaml = isRecord(rawYaml) ? rawYaml : {};
  const internal = buildDefaultPilotDeckConfig();

  if (isRecord(yaml.model?.providers)) {
    internal.models = { providers: {}, entries: {} };
    for (const [pid, provider] of Object.entries(yaml.model.providers)) {
      if (!isRecord(provider)) continue;
      internal.models.providers[pid] = {
        type: protocolToInternalType(provider.protocol),
        baseUrl: normalizeString(provider.url),
        apiKey: normalizeString(provider.apiKey),
        transformer: null,
        headers: isRecord(provider.headers) ? clone(provider.headers) : {},
      };
      if (isRecord(provider.models)) {
        for (const [mid, def] of Object.entries(provider.models)) {
          const entryId = `${pid}/${mid}`;
          const maxContext = isRecord(def?.capabilities)
            ? Number(def.capabilities.maxContextTokens)
            : Number.NaN;
          internal.models.entries[entryId] = {
            provider: pid,
            name: mid,
            contextWindow: Number.isFinite(maxContext) && maxContext > 0 ? maxContext : 160000,
          };
        }
      }
    }
  }

  if (typeof yaml.agent?.model === 'string' && yaml.agent.model.trim()) {
    internal.agents.main.model = yaml.agent.model.trim();
  }

  if (isRecord(yaml.webui?.runtime)) {
    internal.runtime = deepMerge(internal.runtime, yaml.webui.runtime);
  }
  if (isRecord(yaml.webui?.memory)) {
    internal.memory = deepMerge(internal.memory, yaml.webui.memory);
  }

  return internal;
}

function adaptInternalToPilotDeckYaml(internal, rawYaml) {
  // Read-modify-write: start from the raw yaml so non-UI-managed fields
  // (model.providers.<id>.models.<id>.displayName / capabilities /
  // multimodal, agent.fallbackModel, etc.) survive write-backs.
  const yaml = clone(isRecord(rawYaml) ? rawYaml : {});
  yaml.schemaVersion = CONFIG_VERSION;

  yaml.agent = isRecord(yaml.agent) ? yaml.agent : {};
  if (normalizeString(internal.agents?.main?.model)) {
    yaml.agent.model = internal.agents.main.model;
  }

  yaml.model = isRecord(yaml.model) ? yaml.model : {};
  yaml.model.providers = isRecord(yaml.model.providers) ? yaml.model.providers : {};

  if (isRecord(internal.models?.providers)) {
    const incomingPids = new Set(Object.keys(internal.models.providers));
    for (const [pid, p] of Object.entries(internal.models.providers)) {
      const existing = isRecord(yaml.model.providers[pid]) ? yaml.model.providers[pid] : {};
      yaml.model.providers[pid] = {
        ...existing,
        protocol: internalTypeToProtocol(p.type) || existing.protocol || 'openai',
        url: p.baseUrl || existing.url || '',
        apiKey: p.apiKey || existing.apiKey || '',
        timeoutMs: existing.timeoutMs ?? 120000,
        headers: isRecord(p.headers) && Object.keys(p.headers).length > 0
          ? clone(p.headers)
          : (isRecord(existing.headers) ? existing.headers : {}),
        models: isRecord(existing.models) ? existing.models : {},
      };
    }
    for (const pid of Object.keys(yaml.model.providers)) {
      if (!incomingPids.has(pid)) delete yaml.model.providers[pid];
    }
  }

  if (isRecord(internal.models?.entries)) {
    const entriesByProvider = new Map();
    for (const entry of Object.values(internal.models.entries)) {
      if (!entry?.provider || !entry?.name) continue;
      if (!entriesByProvider.has(entry.provider)) entriesByProvider.set(entry.provider, new Set());
      entriesByProvider.get(entry.provider).add(entry.name);
    }
    for (const [pid, provider] of Object.entries(yaml.model.providers)) {
      const validMids = entriesByProvider.get(pid) ?? new Set();
      provider.models = isRecord(provider.models) ? provider.models : {};
      for (const mid of validMids) {
        if (!isRecord(provider.models[mid])) provider.models[mid] = {};
      }
      for (const mid of Object.keys(provider.models)) {
        if (!validMids.has(mid)) delete provider.models[mid];
      }
    }
  }

  yaml.webui = isRecord(yaml.webui) ? yaml.webui : {};
  if (isRecord(internal.runtime)) yaml.webui.runtime = clone(internal.runtime);
  if (isRecord(internal.memory)) yaml.webui.memory = clone(internal.memory);

  return yaml;
}

// ─── public API (matches the previous edgeclawConfig surface) ────────────────

export function getPilotDeckConfigPath() {
  if (process.env.PILOTDECK_CONFIG_PATH?.trim()) {
    return process.env.PILOTDECK_CONFIG_PATH.trim();
  }
  return DEFAULT_CONFIG_PATH;
}

export function readPilotDeckConfigFile() {
  const configPath = getPilotDeckConfigPath();
  if (!fs.existsSync(configPath)) {
    return {
      exists: false,
      configPath,
      raw: '',
      config: buildDefaultPilotDeckConfig(),
      rawYaml: {},
    };
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = parseYaml(raw) || {};
  const config = normalizePilotDeckConfig(parsed);
  return { exists: true, configPath, raw, config, rawYaml: parsed };
}

// Idempotent: callers pass either the raw pilotdeck.yaml object (has
// `model.providers` / `agent.model`) or an already-normalized ui-internal
// config (has `models.providers` / `agents.main.model`). The two shapes are
// disjoint enough to distinguish by key.
export function normalizePilotDeckConfig(input) {
  if (!isRecord(input)) return buildDefaultPilotDeckConfig();
  const looksLikeInternal = isRecord(input.models) || isRecord(input.agents) || isRecord(input.runtime);
  const looksLikeYaml = isRecord(input.model) || (isRecord(input.agent) && typeof input.agent.model === 'string');
  if (looksLikeInternal && !looksLikeYaml) {
    return deepMerge(buildDefaultPilotDeckConfig(), input);
  }
  return adaptPilotDeckYamlToInternal(input);
}

function isSecretKey(key) {
  return SECRET_EXACT_KEYS.has(key) || SECRET_KEY_RE.test(key);
}

export function maskSecrets(value) {
  if (Array.isArray(value)) return value.map(maskSecrets);
  if (!isRecord(value)) return value;
  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSecretKey(key) && typeof child === 'string' && child.trim()) {
      output[key] = MASK;
    } else {
      output[key] = maskSecrets(child);
    }
  }
  return output;
}

export function preserveMaskedSecrets(nextValue, previousValue) {
  if (nextValue === MASK && typeof previousValue === 'string') return previousValue;
  if (Array.isArray(nextValue)) {
    return nextValue.map((item, index) =>
      preserveMaskedSecrets(item, Array.isArray(previousValue) ? previousValue[index] : undefined),
    );
  }
  if (isRecord(nextValue)) {
    const output = {};
    for (const [key, child] of Object.entries(nextValue)) {
      output[key] = preserveMaskedSecrets(child, isRecord(previousValue) ? previousValue[key] : undefined);
    }
    return output;
  }
  return nextValue;
}

export function resolveModel(config, modelId, options = {}) {
  const effectiveId = modelId === 'inherit' || !modelId
    ? normalizeString(config?.agents?.main?.model)
    : normalizeString(modelId);
  const entry = config?.models?.entries?.[effectiveId];
  if (!isRecord(entry)) {
    if (options.allowMissing) return null;
    throw new Error(`Model entry not found: ${effectiveId || modelId}`);
  }
  const providerId = normalizeString(entry.provider);
  const provider = config?.models?.providers?.[providerId];
  if (!isRecord(provider)) {
    if (options.allowMissing) return null;
    throw new Error(`Provider not found for model "${effectiveId}": ${providerId}`);
  }
  return {
    id: effectiveId,
    providerId,
    provider,
    model: normalizeString(entry.name),
    entry,
  };
}

function validateProvider(id, provider, errors) {
  if (!normalizeString(provider?.type)) errors.push(`models.providers.${id}.type is required`);
  if (!normalizeString(provider?.baseUrl)) errors.push(`models.providers.${id}.baseUrl is required`);
  if (!normalizeString(provider?.apiKey)) errors.push(`models.providers.${id}.apiKey is required`);
}

export function validatePilotDeckConfig(config) {
  const normalized = normalizePilotDeckConfig(config);
  const errors = [];
  const warnings = [];

  if (!normalizeString(normalized.agents.main.model)) {
    warnings.push('agents.main.model is empty; pick a model from models.entries.');
  } else {
    const main = resolveModel(normalized, normalized.agents.main.model, { allowMissing: true });
    if (!main) {
      errors.push('agents.main.model must reference a model in models.entries');
    } else if (!main.model) {
      errors.push(`models.entries.${main.id}.name is required`);
    } else {
      validateProvider(main.providerId, main.provider, errors);
    }
  }

  if (normalized.memory.enabled && normalized.memory.model !== 'inherit') {
    const memory = resolveModel(normalized, normalized.memory.model, { allowMissing: true });
    if (!memory) errors.push('memory.model must be inherit or reference a model in models.entries');
    else if (!memory.model) errors.push(`models.entries.${memory.id}.name is required`);
  }

  return { valid: errors.length === 0, errors, warnings, config: normalized };
}

export function buildRuntimeEnv(config) {
  const normalized = normalizePilotDeckConfig(config);
  const main = resolveModel(normalized, normalized.agents.main.model, { allowMissing: true });
  const runtime = normalized.runtime;
  const proxyPort = String(runtime.proxyPort ?? 18080);
  const env = {
    PILOTDECK_PROXY_PORT: process.env.PILOTDECK_PROXY_PORT || proxyPort,
    PROXY_PORT: process.env.PROXY_PORT || proxyPort,
    SERVER_PORT: process.env.SERVER_PORT || String(runtime.serverPort ?? 3001),
    VITE_PORT: process.env.VITE_PORT || String(runtime.vitePort ?? 5173),
    HOST: process.env.HOST || String(runtime.host ?? '0.0.0.0'),
    CONTEXT_WINDOW: String(runtime.contextWindow ?? 160000),
    VITE_CONTEXT_WINDOW: String(runtime.contextWindow ?? 160000),
    API_TIMEOUT_MS: String(runtime.apiTimeoutMs ?? 120000),
    PILOTDECK_MEMORY_ENABLED: normalized.memory.enabled ? '1' : '0',
  };

  if (runtime.databasePath) env.DATABASE_PATH = expandTilde(runtime.databasePath);
  if (runtime.workspacesRoot) env.WORKSPACES_ROOT = expandTilde(runtime.workspacesRoot);
  if (runtime.httpsProxy) {
    env.HTTPS_PROXY = runtime.httpsProxy;
    env.https_proxy = runtime.httpsProxy;
  }

  if (main) {
    env.PILOTDECK_API_BASE_URL = main.provider.baseUrl;
    env.PILOTDECK_API_KEY = main.provider.apiKey;
    env.PILOTDECK_MODEL = main.model;
    env.OPENAI_BASE_URL = main.provider.baseUrl;
    env.OPENAI_API_KEY = main.provider.apiKey;
    env.OPENAI_MODEL = main.model;
    env.ANTHROPIC_API_KEY = main.provider.apiKey;
    env.ANTHROPIC_MODEL = main.model;
  }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;

  // Reasoning models (MiniMax-M2.7, DeepSeek-R1, etc.) emit large thinking
  // blocks BEFORE the answer; honor a per-config override under
  // agents.main.params.maxOutputTokens (or max_tokens) and propagate it
  // as CLAUDE_CODE_MAX_OUTPUT_TOKENS for the claude-code-main bridge.
  const mainParams = normalized.agents?.main?.params ?? {};
  const requestedMaxOutput = Number.parseInt(
    String(
      mainParams.maxOutputTokens ??
        mainParams.max_output_tokens ??
        mainParams.max_tokens ??
        ''
    ).trim(),
    10,
  );
  if (Number.isFinite(requestedMaxOutput) && requestedMaxOutput > 0) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(requestedMaxOutput);
  } else if (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS) {
    env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS;
  }

  const tavilyKey = mainParams.tavilyApiKey ?? mainParams.tavily_api_key ?? process.env.TAVILY_API_KEY;
  if (tavilyKey) env.TAVILY_API_KEY = String(tavilyKey);

  const memory = resolveModel(normalized, normalized.memory.model, { allowMissing: true });
  if (memory) {
    env.PILOTDECK_MEMORY_MODEL = memory.model;
    env.PILOTDECK_MEMORY_PROVIDER = memory.providerId;
    env.PILOTDECK_MEMORY_BASE_URL = memory.provider.baseUrl;
    env.PILOTDECK_MEMORY_API_KEY = memory.provider.apiKey;
    env.PILOTDECK_MEMORY_API_TYPE = providerTypeToMemoryApi(memory.provider.type);
  }

  return env;
}

export function applyConfigToProcessEnv(config) {
  Object.assign(process.env, buildRuntimeEnv(config));
}

function providerTypeToMemoryApi(type) {
  return type === 'openai-responses' ? 'openai-responses' : 'openai-completions';
}

export function buildMemoryLlmOptions(config) {
  const memory = resolveModel(normalizePilotDeckConfig(config), config.memory?.model, { allowMissing: true });
  if (!memory) return undefined;
  return {
    provider: memory.providerId,
    model: memory.model,
    apiType: providerTypeToMemoryApi(memory.provider.type),
    baseUrl: memory.provider.baseUrl,
    apiKey: memory.provider.apiKey,
    headers: memory.provider.headers ?? {},
  };
}

export function buildMemoryDefaults(config) {
  const memory = normalizePilotDeckConfig(config).memory;
  return {
    llm: buildMemoryLlmOptions(config),
    defaultIndexingSettings: {
      reasoningMode: memory.reasoningMode,
      autoIndexIntervalMinutes: memory.autoIndexIntervalMinutes,
      autoDreamIntervalMinutes: memory.autoDreamIntervalMinutes,
    },
    captureStrategy: memory.captureStrategy,
    includeAssistant: memory.includeAssistant,
    maxMessageChars: memory.maxMessageChars,
    heartbeatBatchSize: memory.heartbeatBatchSize,
  };
}

export async function writePilotDeckConfig(config) {
  const normalized = normalizePilotDeckConfig(config);
  const validation = validatePilotDeckConfig(normalized);
  if (!validation.valid) {
    const error = new Error('Invalid PilotDeck config');
    error.validation = validation;
    throw error;
  }
  const configPath = getPilotDeckConfigPath();
  let existingRawYaml = {};
  if (fs.existsSync(configPath)) {
    try {
      existingRawYaml = parseYaml(fs.readFileSync(configPath, 'utf8')) || {};
    } catch {
      existingRawYaml = {};
    }
  }
  const yamlForDisk = adaptInternalToPilotDeckYaml(normalized, existingRawYaml);
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const raw = stringifyYaml(yamlForDisk, { lineWidth: 0 });
  await fsPromises.writeFile(configPath, raw, 'utf8');
  return { configPath, raw, validation, config: normalized };
}

export function expandTilde(value) {
  const text = normalizeString(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export async function writeRawPilotDeckYaml(yamlObj) {
  const validation = validatePilotDeckConfig(yamlObj);
  if (!validation.valid) {
    const error = new Error('Invalid PilotDeck config');
    error.validation = validation;
    throw error;
  }
  const configPath = getPilotDeckConfigPath();
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const raw = stringifyYaml(yamlObj, { lineWidth: 0 });
  await fsPromises.writeFile(configPath, raw, 'utf8');
  return { configPath, raw, validation, config: validation.config };
}

export function rawYamlToMaskedString(rawYaml) {
  const obj = isRecord(rawYaml) ? rawYaml : {};
  return stringifyYaml(maskSecrets(obj), { lineWidth: 0 });
}

export function configToYaml(config) {
  const normalized = normalizePilotDeckConfig(config);
  const yamlShape = adaptInternalToPilotDeckYaml(normalized, {});
  return stringifyYaml(yamlShape, { lineWidth: 0 });
}

export function parseConfigYaml(raw) {
  return normalizePilotDeckConfig(parseYaml(raw) || {});
}
