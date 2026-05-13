import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// Source of truth: ~/.pilotdeck/pilotdeck.yaml. The disk format and the
// "internal" config object are the same V2 schema — no more adapter layer.
//
// Top-level shape:
//   schemaVersion: 1
//   agent:    { model: "provider/model", params, subagents }
//   model:    { providers: { [pid]: { protocol, url, apiKey, models, headers, timeoutMs } } }
//   memory:   { enabled, model, apiType?, reasoningMode, ... }
//   webui:    { runtime: { host, serverPort, vitePort, proxyPort, ... } }
//   router:   { enabled, stats: { enabled, modelPricing }, ... }
//   gateway:  { enabled, home, ... }
//   alwaysOn: { enabled, trigger, dormancy, workspace, execution, projects }
//   customEnv:{ KEY: VALUE }    (UI-only; engine ignores)
//
// Everything not in this list (router/gateway/alwaysOn deep fields, etc.)
// flows through verbatim — the gateway-side PilotConfigStore owns those
// schemas. UI server just round-trips them.

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

// ─── Defaults ────────────────────────────────────────────────────────────────

export function buildDefaultPilotDeckConfig() {
  return {
    schemaVersion: CONFIG_VERSION,
    agent: {
      model: '',
      params: {},
      subagents: { default: 'inherit', params: {} },
    },
    model: {
      providers: {},
    },
    memory: {
      enabled: true,
      reasoningMode: 'answer_first',
      autoIndexIntervalMinutes: 30,
      autoDreamIntervalMinutes: 60,
      captureStrategy: 'last_turn',
      includeAssistant: true,
      maxMessageChars: 6000,
      heartbeatBatchSize: 30,
    },
    webui: {
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
    },
  };
}

// `normalize` here means "fill in missing top-level sections with defaults"
// — it never reshapes. Idempotent.
export function normalizePilotDeckConfig(input) {
  return deepMerge(buildDefaultPilotDeckConfig(), isRecord(input) ? input : {});
}

// ─── Model resolution ────────────────────────────────────────────────────────

function splitModelRef(ref) {
  const text = normalizeString(ref);
  if (!text) return null;
  // Allow nested slashes: "openrouter/anthropic/claude-sonnet-4.6" →
  // provider="openrouter", model="anthropic/claude-sonnet-4.6"
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) return null;
  return { providerId: text.slice(0, slash), modelId: text.slice(slash + 1) };
}

// Returns { id, providerId, provider, model, def } or null if the
// reference doesn't resolve. `id` is the canonical "provider/model"
// string (after inherit-resolution).
export function resolveModel(config, ref, options = {}) {
  const inheritFallback = normalizeString(config?.agent?.model);
  const refText = normalizeString(ref);
  const effective = (!refText || refText === 'inherit')
    ? inheritFallback
    : refText;
  const parts = splitModelRef(effective);
  if (!parts) {
    if (options.allowMissing) return null;
    throw new Error(`Invalid model reference: ${ref ?? ''}`);
  }
  const provider = config?.model?.providers?.[parts.providerId];
  if (!isRecord(provider)) {
    if (options.allowMissing) return null;
    throw new Error(`Provider not found for model "${effective}": ${parts.providerId}`);
  }
  const def = isRecord(provider.models) ? provider.models[parts.modelId] : null;
  return {
    id: effective,
    providerId: parts.providerId,
    provider,
    model: parts.modelId,
    def: isRecord(def) ? def : {},
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

function validateProvider(id, provider, errors) {
  if (!isRecord(provider)) {
    errors.push(`model.providers.${id} must be an object`);
    return;
  }
  const protocol = normalizeString(provider.protocol).toLowerCase();
  if (!protocol) errors.push(`model.providers.${id}.protocol is required`);
  else if (protocol !== 'openai' && protocol !== 'anthropic') {
    errors.push(`model.providers.${id}.protocol must be "openai" or "anthropic"`);
  }
  if (!normalizeString(provider.url)) errors.push(`model.providers.${id}.url is required`);
  if (!normalizeString(provider.apiKey)) errors.push(`model.providers.${id}.apiKey is required`);
}

export function validatePilotDeckConfig(config) {
  const normalized = normalizePilotDeckConfig(config);
  const errors = [];
  const warnings = [];

  const mainRef = normalizeString(normalized.agent.model);
  if (!mainRef) {
    warnings.push('agent.model is empty; pick a model from model.providers.');
  } else {
    const main = resolveModel(normalized, mainRef, { allowMissing: true });
    if (!main) {
      errors.push(`agent.model="${mainRef}" doesn't resolve to a configured provider/model`);
    } else {
      validateProvider(main.providerId, main.provider, errors);
    }
  }

  if (normalized.memory?.enabled && normalizeString(normalized.memory.model)) {
    const ref = normalizeString(normalized.memory.model);
    if (ref !== 'inherit') {
      const memory = resolveModel(normalized, ref, { allowMissing: true });
      if (!memory) {
        errors.push(`memory.model="${ref}" doesn't resolve to a configured provider/model`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings, config: normalized };
}

// ─── Secret masking ──────────────────────────────────────────────────────────

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

// ─── Runtime env derivation ──────────────────────────────────────────────────

function providerProtocolToMemoryApi(protocol) {
  // V2 catalog only uses 'openai' (Chat Completions) and 'anthropic'.
  // The /responses style is only relevant when a user manually sets
  // memory.apiType, which they can do alongside protocol="openai".
  return 'openai-completions';
}

export function buildRuntimeEnv(config) {
  const normalized = normalizePilotDeckConfig(config);
  const main = resolveModel(normalized, normalized.agent.model, { allowMissing: true });
  const runtime = normalized.webui?.runtime ?? {};
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
    PILOTDECK_MEMORY_ENABLED: normalized.memory?.enabled ? '1' : '0',
  };

  if (runtime.databasePath) env.DATABASE_PATH = expandTilde(runtime.databasePath);
  if (runtime.workspacesRoot) env.WORKSPACES_ROOT = expandTilde(runtime.workspacesRoot);
  if (runtime.httpsProxy) {
    env.HTTPS_PROXY = runtime.httpsProxy;
    env.https_proxy = runtime.httpsProxy;
  }

  if (main) {
    env.PILOTDECK_API_BASE_URL = main.provider.url || '';
    env.PILOTDECK_API_KEY = main.provider.apiKey || '';
    env.PILOTDECK_MODEL = main.model;
    env.OPENAI_BASE_URL = main.provider.url || '';
    env.OPENAI_API_KEY = main.provider.apiKey || '';
    env.OPENAI_MODEL = main.model;
    env.ANTHROPIC_API_KEY = main.provider.apiKey || '';
    env.ANTHROPIC_MODEL = main.model;
  }
  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;

  // Reasoning models (DeepSeek-R1, MiniMax-M2.7, etc.) need a generous
  // output token cap; honor agent.params.maxOutputTokens / max_tokens.
  const mainParams = normalized.agent?.params ?? {};
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

  // Memory uses memory.model (or inherits agent.model when blank).
  const memoryRef = normalizeString(normalized.memory?.model) || normalized.agent.model;
  const memory = resolveModel(normalized, memoryRef, { allowMissing: true });
  if (memory) {
    env.PILOTDECK_MEMORY_MODEL = memory.model;
    env.PILOTDECK_MEMORY_PROVIDER = memory.providerId;
    env.PILOTDECK_MEMORY_BASE_URL = memory.provider.url || '';
    env.PILOTDECK_MEMORY_API_KEY = memory.provider.apiKey || '';
    env.PILOTDECK_MEMORY_API_TYPE = normalizeString(normalized.memory?.apiType)
      || providerProtocolToMemoryApi(memory.provider.protocol);
  }

  // Pass through customEnv (UI-managed escape hatch).
  if (isRecord(normalized.customEnv)) {
    for (const [key, value] of Object.entries(normalized.customEnv)) {
      if (typeof value === 'string' && value.trim()) env[key] = value;
    }
  }

  return env;
}

export function applyConfigToProcessEnv(config) {
  Object.assign(process.env, buildRuntimeEnv(config));
}

// ─── Memory service options ──────────────────────────────────────────────────

export function buildMemoryLlmOptions(config) {
  const normalized = normalizePilotDeckConfig(config);
  const ref = normalizeString(normalized.memory?.model) || normalized.agent.model;
  const memory = resolveModel(normalized, ref, { allowMissing: true });
  if (!memory) return undefined;
  return {
    provider: memory.providerId,
    model: memory.model,
    apiType: normalizeString(normalized.memory?.apiType)
      || providerProtocolToMemoryApi(memory.provider.protocol),
    baseUrl: memory.provider.url || '',
    apiKey: memory.provider.apiKey || '',
    headers: isRecord(memory.provider.headers) ? memory.provider.headers : {},
  };
}

export function buildMemoryDefaults(config) {
  const memory = normalizePilotDeckConfig(config).memory ?? {};
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

// ─── File I/O ────────────────────────────────────────────────────────────────

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

// Lossless writer — config object is the V2 disk shape, written verbatim
// after running through validation. UI-internal === disk schema, so
// there's no read-modify-write needed anymore (the previous translation
// layer existed only to bridge an older internal schema).
export async function writePilotDeckConfig(config) {
  const validation = validatePilotDeckConfig(config);
  if (!validation.valid) {
    const error = new Error('Invalid PilotDeck config');
    error.validation = validation;
    throw error;
  }
  const configPath = getPilotDeckConfigPath();
  await fsPromises.mkdir(path.dirname(configPath), { recursive: true });
  const yamlObj = validation.config;
  const raw = stringifyYaml(yamlObj, { lineWidth: 0 });
  await fsPromises.writeFile(configPath, raw, 'utf8');
  return { configPath, raw, validation, config: yamlObj };
}

// Kept as a thin alias for callers that supply an already-parsed YAML
// object (Raw YAML editor path). Behaviour is identical to
// writePilotDeckConfig now that internal === disk.
export async function writeRawPilotDeckYaml(yamlObj) {
  return writePilotDeckConfig(yamlObj);
}

export function expandTilde(value) {
  const text = normalizeString(value);
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
}

export function configToYaml(config) {
  const normalized = normalizePilotDeckConfig(config);
  return stringifyYaml(normalized, { lineWidth: 0 });
}

// Lossless masked serialization for the "Raw YAML" view. Now that
// internal === disk, this is just `stringifyYaml(maskSecrets(rawYaml))`.
export function rawYamlToMaskedString(rawYaml) {
  const obj = isRecord(rawYaml) ? rawYaml : {};
  return stringifyYaml(maskSecrets(obj), { lineWidth: 0 });
}

export function parseConfigYaml(raw) {
  return normalizePilotDeckConfig(parseYaml(raw) || {});
}
