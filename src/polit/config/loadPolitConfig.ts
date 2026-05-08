import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseModelConfig } from "../../model/config/parseModelConfig.js";
import { isRecord } from "../../model/config/schema.js";
import { ModelConfigError } from "../../model/protocol/errors.js";
import { getPolitConfigFilePath, resolvePolitHome } from "../paths.js";
import { sha256, stableStringify } from "./hash.js";
import { mergeConfigSources } from "./merge.js";
import { parseMemoryConfig } from "./parseMemoryConfig.js";
import { parseAdaptersConfig, parseGatewayConfig } from "./parseGatewayConfig.js";
import { redactConfig } from "./redact.js";
import {
  PolitConfigError,
  type PolitAgentConfig,
  type PolitAgentModelSelection,
  type PolitConfigDiagnostic,
  type PolitExtensionConfig,
  type PolitConfigLoadOptions,
  type PolitConfigSnapshot,
  type PolitConfigSource,
  type PolitRawConfig,
} from "./types.js";

const SUPPORTED_SCHEMA_VERSION = 1;
const PROJECT_CONFIG_FILE_NAME = ".politdeck.yaml";

const ENV_CONFIG_OVERRIDES = [
  ["POLIT_AGENT_MODEL", ["agent", "model"]],
  ["POLIT_AGENT_FALLBACK_MODEL", ["agent", "fallbackModel"]],
] as const;

export function loadPolitConfig(options: PolitConfigLoadOptions = {}): PolitConfigSnapshot {
  const env = options.env ?? process.env;
  const loadedAt = new Date();
  const diagnostics: PolitConfigDiagnostic[] = [];
  const sources: PolitConfigSource[] = [];

  const politHome = resolvePolitHome(env);
  if (env.POLIT_HOME) {
    sources.push({
      kind: "env",
      phase: "bootstrap",
      priority: 30,
      loadedAt,
      contentHash: sha256("POLIT_HOME=<redacted-path>"),
    });
  }

  const defaultConfigPath = getPolitConfigFilePath(politHome);
  const defaultConfig = readYamlSource(defaultConfigPath, "default", 10, loadedAt, diagnostics, sources);

  const projectConfigPath = options.projectRoot
    ? resolve(options.projectRoot, PROJECT_CONFIG_FILE_NAME)
    : undefined;
  const projectConfig = projectConfigPath
    ? readYamlSource(projectConfigPath, "project", 20, loadedAt, diagnostics, sources)
    : undefined;

  const envConfig = readEnvOverrides(env);
  if (envConfig) {
    sources.push({
      kind: "env",
      phase: "merge",
      priority: 30,
      loadedAt,
      contentHash: sha256(stableStringify(redactConfig(envConfig))),
    });
  }

  const rawConfig = mergeConfigSources(defaultConfig, projectConfig, envConfig) as PolitRawConfig;
  validateTopLevel(rawConfig, diagnostics);
  const schemaVersion = parseSchemaVersion(rawConfig.schemaVersion, diagnostics);

  if (rawConfig.agent === undefined) {
    diagnostics.push({
      code: "CONFIG_AGENT_MISSING",
      severity: "fatal",
      message: "Config must contain an agent section.",
      path: "agent",
      recoverable: false,
    });
  }

  if (rawConfig.model === undefined) {
    diagnostics.push({
      code: "CONFIG_MODEL_MISSING",
      severity: "fatal",
      message: "Config must contain a model section.",
      path: "model",
      recoverable: false,
    });
  }
  throwConfigErrorIfFatal(diagnostics);

  const model = parseModel(rawConfig.model, env, diagnostics);
  const agent = parseAgent(rawConfig.agent, model, diagnostics);
  const extension = parseExtension(rawConfig.extension, diagnostics);
  const memory = parseMemoryConfig(rawConfig.memory, diagnostics);
  const gateway = parseGatewayConfig(rawConfig.gateway, diagnostics);
  const adapters = parseAdaptersConfig(rawConfig.adapters, diagnostics);
  throwConfigErrorIfFatal(diagnostics);

  const redactedSnapshotConfig = redactConfig({ agent, model, extension, memory, gateway, adapters });
  return deepFreeze({
    version: options.version ?? 1,
    schemaVersion,
    loadedAt,
    contentHash: sha256(stableStringify(redactedSnapshotConfig)),
    sources,
    diagnostics,
    config: {
      agent,
      model,
      extension,
      ...(memory ? { memory } : {}),
      ...(gateway ? { gateway } : {}),
      ...(adapters ? { adapters } : {}),
    },
  });
}

function readYamlSource(
  path: string,
  kind: "default" | "project",
  priority: number,
  loadedAt: Date,
  diagnostics: PolitConfigDiagnostic[],
  sources: PolitConfigSource[],
): Record<string, unknown> | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (error) {
    diagnostics.push({
      code: "CONFIG_READ_FAILED",
      severity: "fatal",
      message: `Failed to read ${kind} config.`,
      path,
      source: { kind, path },
      hint: error instanceof Error ? error.message : undefined,
      recoverable: false,
    });
    return undefined;
  }

  sources.push({
    kind,
    priority,
    loadedAt,
    path,
    contentHash: sha256(content),
  });

  try {
    const document = parseDocument(content, { prettyErrors: false });
    if (document.errors.length > 0) {
      diagnostics.push({
        code: "CONFIG_YAML_INVALID",
        severity: "fatal",
        message: `Failed to parse ${kind} config YAML.`,
        path,
        source: { kind, path },
        hint: document.errors.map((yamlError) => yamlError.message).join("; "),
        recoverable: false,
      });
      return undefined;
    }

    const parsed = document.toJSON();
    if (parsed === null || parsed === undefined) {
      return {};
    }
    if (!isRecord(parsed)) {
      diagnostics.push({
        code: "CONFIG_ROOT_INVALID",
        severity: "fatal",
        message: `${kind} config root must be an object.`,
        path,
        source: { kind, path },
        recoverable: false,
      });
      return undefined;
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      code: "CONFIG_YAML_INVALID",
      severity: "fatal",
      message: `Failed to parse ${kind} config YAML.`,
      path,
      source: { kind, path },
      hint: error instanceof Error ? error.message : undefined,
      recoverable: false,
    });
    return undefined;
  }
}

function readEnvOverrides(env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  const output: Record<string, unknown> = {};

  for (const [envName, path] of ENV_CONFIG_OVERRIDES) {
    const value = env[envName];
    if (!value) {
      continue;
    }
    setPath(output, path, value);
  }

  return Object.keys(output).length > 0 ? output : undefined;
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let cursor = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    const next = cursor[key];
    if (!isRecord(next)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

function validateTopLevel(rawConfig: PolitRawConfig, diagnostics: PolitConfigDiagnostic[]): void {
  if (!isRecord(rawConfig)) {
    diagnostics.push({
      code: "CONFIG_ROOT_INVALID",
      severity: "fatal",
      message: "Config root must be an object.",
      recoverable: false,
    });
    return;
  }

  if ("polit" in rawConfig) {
    diagnostics.push({
      code: "CONFIG_POLIT_SECTION_FORBIDDEN",
      severity: "fatal",
      message: "YAML config must not contain a polit section. Use POLIT_HOME for PolitHome.",
      path: "polit",
      recoverable: false,
    });
  }

  const allowedKeys = new Set([
    "schemaVersion",
    "agent",
    "model",
    "extension",
    "memory",
    "gateway",
    "adapters",
  ]);
  for (const key of Object.keys(rawConfig)) {
    if (!allowedKeys.has(key)) {
      diagnostics.push({
        code: "CONFIG_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown top-level config field ${key}.`,
        path: key,
        recoverable: true,
      });
    }
  }
}

function parseAgent(
  rawAgent: unknown,
  modelConfig: ReturnType<typeof parseModel>,
  diagnostics: PolitConfigDiagnostic[],
): PolitAgentConfig {
  if (!isRecord(rawAgent)) {
    diagnostics.push({
      code: "CONFIG_AGENT_INVALID",
      severity: "fatal",
      message: "Agent config must be an object.",
      path: "agent",
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent config diagnostic.");
  }

  const model = parseAgentModelSelection(rawAgent.model, "agent.model", modelConfig, diagnostics);
  const fallbackModel =
    rawAgent.fallbackModel === undefined
      ? undefined
      : parseAgentModelSelection(rawAgent.fallbackModel, "agent.fallbackModel", modelConfig, diagnostics);
  throwConfigErrorIfFatal(diagnostics);

  return {
    model,
    fallbackModel,
  };
}

function parseAgentModelSelection(
  value: unknown,
  path: string,
  modelConfig: ReturnType<typeof parseModel>,
  diagnostics: PolitConfigDiagnostic[],
): PolitAgentModelSelection {
  if (typeof value !== "string" || value.length === 0) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_INVALID",
      severity: "fatal",
      message: `${path} must be a non-empty provider/model string.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model diagnostic.");
  }

  const separatorIndex = value.indexOf("/");
  const providerId = separatorIndex >= 0 ? value.slice(0, separatorIndex) : "";
  const modelId = separatorIndex >= 0 ? value.slice(separatorIndex + 1) : "";
  if (!providerId || !modelId) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_INVALID",
      severity: "fatal",
      message: `${path} must use provider/model format.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model format diagnostic.");
  }

  const provider = modelConfig.providers[providerId];
  if (!provider) {
    diagnostics.push({
      code: "CONFIG_AGENT_PROVIDER_NOT_FOUND",
      severity: "fatal",
      message: `${path} references unknown provider ${providerId}.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent provider diagnostic.");
  }

  if (!provider.models[modelId]) {
    diagnostics.push({
      code: "CONFIG_AGENT_MODEL_NOT_FOUND",
      severity: "fatal",
      message: `${path} references unknown model ${modelId} for provider ${providerId}.`,
      path,
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
    throw new Error("Unreachable after fatal agent model lookup diagnostic.");
  }

  return {
    id: value,
    provider: providerId,
    model: modelId,
  };
}

function parseSchemaVersion(
  value: unknown,
  diagnostics: PolitConfigDiagnostic[],
): number {
  if (value === undefined) {
    diagnostics.push({
      code: "CONFIG_SCHEMA_VERSION_MISSING",
      severity: "warning",
      message: "schemaVersion is missing; assuming schemaVersion 1.",
      path: "schemaVersion",
      recoverable: true,
    });
    return SUPPORTED_SCHEMA_VERSION;
  }

  if (value !== SUPPORTED_SCHEMA_VERSION) {
    diagnostics.push({
      code: "CONFIG_SCHEMA_VERSION_UNSUPPORTED",
      severity: "fatal",
      message: `Unsupported schemaVersion ${String(value)}.`,
      path: "schemaVersion",
      recoverable: false,
    });
    return SUPPORTED_SCHEMA_VERSION;
  }

  return SUPPORTED_SCHEMA_VERSION;
}

function parseModel(
  rawModel: unknown,
  env: Record<string, string | undefined>,
  diagnostics: PolitConfigDiagnostic[],
) {
  try {
    return parseModelConfig(rawModel, { env });
  } catch (error) {
    if (error instanceof ModelConfigError) {
      diagnostics.push({
        code: `MODEL_${error.code.toUpperCase()}`,
        severity: "fatal",
        message: error.message,
        path: "model",
        hint: stringifyDetails(error.details),
        recoverable: false,
      });
      throwConfigErrorIfFatal(diagnostics);
    }
    throw error;
  }
}

function parseExtension(rawExtension: unknown, diagnostics: PolitConfigDiagnostic[]): PolitExtensionConfig {
  const defaults: PolitExtensionConfig = {
    builtinPluginsEnabled: {},
    includeHookEvents: false,
  };
  if (rawExtension === undefined) {
    return defaults;
  }
  if (!isRecord(rawExtension)) {
    diagnostics.push({
      code: "CONFIG_EXTENSION_INVALID",
      severity: "fatal",
      message: "extension config must be an object.",
      path: "extension",
      recoverable: false,
    });
    return defaults;
  }

  const extension = { ...defaults };
  if (rawExtension.builtinPluginsEnabled !== undefined) {
    if (isRecord(rawExtension.builtinPluginsEnabled)) {
      extension.builtinPluginsEnabled = Object.fromEntries(
        Object.entries(rawExtension.builtinPluginsEnabled).filter(
          (entry): entry is [string, boolean] => typeof entry[1] === "boolean",
        ),
      );
    } else {
      diagnostics.push({
        code: "CONFIG_EXTENSION_BUILTIN_PLUGINS_INVALID",
        severity: "fatal",
        message: "extension.builtinPluginsEnabled must be an object of booleans.",
        path: "extension.builtinPluginsEnabled",
        recoverable: false,
      });
    }
  }
  if (rawExtension.includeHookEvents !== undefined) {
    if (typeof rawExtension.includeHookEvents === "boolean") {
      extension.includeHookEvents = rawExtension.includeHookEvents;
    } else {
      diagnostics.push({
        code: "CONFIG_EXTENSION_INCLUDE_HOOK_EVENTS_INVALID",
        severity: "fatal",
        message: "extension.includeHookEvents must be a boolean.",
        path: "extension.includeHookEvents",
        recoverable: false,
      });
    }
  }

  for (const key of Object.keys(rawExtension)) {
    if (key !== "builtinPluginsEnabled" && key !== "includeHookEvents") {
      diagnostics.push({
        code: "CONFIG_EXTENSION_UNKNOWN_FIELD",
        severity: "warning",
        message: `Unknown extension config field ${key}.`,
        path: `extension.${key}`,
        recoverable: true,
      });
    }
  }

  return extension;
}

function stringifyDetails(details: unknown): string | undefined {
  if (details === undefined) {
    return undefined;
  }
  return stableStringify(redactConfig(details));
}

function throwConfigErrorIfFatal(diagnostics: PolitConfigDiagnostic[]): void {
  const fatalDiagnostics = diagnostics.filter((diagnostic) => diagnostic.severity === "fatal");
  if (fatalDiagnostics.length > 0) {
    throw new PolitConfigError(
      fatalDiagnostics[0].code,
      fatalDiagnostics[0].message,
      diagnostics,
    );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const entryValue of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entryValue);
    }
  }
  return value;
}
