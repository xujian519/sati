import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";
import { parseModelConfig } from "../../model/config/parseModelConfig.js";
import { isRecord } from "../../model/config/schema.js";
import { ModelConfigError } from "../../model/protocol/errors.js";
import { getPolitConfigFilePath, resolvePolitHome } from "../paths.js";
import { sha256, stableStringify } from "./hash.js";
import { mergeConfigSources } from "./merge.js";
import { redactConfig } from "./redact.js";
import {
  PolitConfigError,
  type PolitConfigDiagnostic,
  type PolitConfigLoadOptions,
  type PolitConfigSnapshot,
  type PolitConfigSource,
  type PolitRawConfig,
} from "./types.js";

const SUPPORTED_SCHEMA_VERSION = 1;
const PROJECT_CONFIG_FILE_NAME = ".politdeck.yaml";

const ENV_MODEL_OVERRIDES = [
  ["POLIT_MODEL_DEFAULT_PROVIDER", ["model", "defaultProvider"]],
  ["POLIT_MODEL_DEFAULT_MODEL", ["model", "defaultModel"]],
  ["POLIT_MODEL_FALLBACK_MODEL", ["model", "fallbackModel"]],
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

  if (rawConfig.model === undefined) {
    diagnostics.push({
      code: "CONFIG_MODEL_MISSING",
      severity: "fatal",
      message: "Config must contain a model section.",
      path: "model",
      recoverable: false,
    });
    throwConfigErrorIfFatal(diagnostics);
  }

  const model = parseModel(rawConfig.model, env, diagnostics);
  throwConfigErrorIfFatal(diagnostics);

  const redactedSnapshotConfig = redactConfig({ model });
  return deepFreeze({
    version: options.version ?? 1,
    schemaVersion,
    loadedAt,
    contentHash: sha256(stableStringify(redactedSnapshotConfig)),
    sources,
    diagnostics,
    config: {
      model,
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

  for (const [envName, path] of ENV_MODEL_OVERRIDES) {
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

  for (const key of Object.keys(rawConfig)) {
    if (key !== "schemaVersion" && key !== "model") {
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
