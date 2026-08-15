import { ModelConfigError } from "../protocol/errors.js";

export type CredentialEnv = Record<string, string | undefined>;

export const ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Stable code: no credential was provided at any configuration entry point (fixable). */
export const CREDENTIAL_MISSING_CODE = "missing_credential";
/** Stable code: a credential was provided but its format cannot be carried in an HTTP header (retry is pointless). */
export const CREDENTIAL_INVALID_CODE = "invalid_credential";

/**
 * Resolve a provider apiKey from raw config.
 *
 * Whitespace handling: `value` and any `${VAR}`-resolved env value are both
 * trimmed before use. A stray space inside a YAML literal (e.g.
 * `apiKey: " sk-..."`) or an env variable that ships a trailing newline
 * would otherwise be pasted verbatim into `Authorization: Bearer  sk-...`,
 * which most providers reject as `invalid_token` / `无效的令牌`. Trimming at
 * the source guarantees every downstream caller (streamModel, AlwaysOn,
 * Cron, plugins) sees the cleaned value.
 *
 * Failure codes (phase 4 T10): `missing_credential` when nothing usable was
 * provided (absent value, empty value, or an unset env reference), and
 * `invalid_credential` when a value was provided but cannot be carried in an
 * HTTP header (line breaks or control characters). The distinction routes
 * MISSING to an actionable configuration hint and INVALID to a no-retry stop.
 */
export function resolveApiKey(value: unknown, env: CredentialEnv = process.env): string {
  if (typeof value !== "string") {
    throw new ModelConfigError(CREDENTIAL_MISSING_CODE, "Provider apiKey must be a non-empty string.");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ModelConfigError(CREDENTIAL_MISSING_CODE, "Provider apiKey must be a non-empty string.");
  }

  const match = ENV_REFERENCE_PATTERN.exec(trimmed);
  if (!match) {
    assertUsableCredential(trimmed);
    return trimmed;
  }

  const envName = match[1];
  const rawResolved = env[envName];
  const resolved = typeof rawResolved === "string" ? rawResolved.trim() : "";
  if (!resolved) {
    throw new ModelConfigError(CREDENTIAL_MISSING_CODE, `Environment variable ${envName} is not set.`, {
      envName,
    });
  }

  assertUsableCredential(resolved);
  return resolved;
}

/**
 * Reject a resolved credential that no HTTP header can carry.
 *
 * Header values cannot contain CR/LF (header-injection boundary) or control
 * characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F). The error message names the
 * failing kind but never echoes any part of the value, so logs stay redacted.
 *
 * @param value - the trimmed credential to validate.
 */
export function assertUsableCredential(value: string): void {
  // Header values cannot carry CR/LF (header-injection boundary) or control
  // characters (0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F).
  if (/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) {
    throw new ModelConfigError(
      CREDENTIAL_INVALID_CODE,
      "Provider apiKey contains characters an HTTP header cannot carry (line breaks or control characters).",
    );
  }
}

/**
 * 判断配置值是否为 `${VAR}` 环境变量引用（惰性解析判据）。
 * @param value 已 trim 的原始配置值。
 */
export function isEnvReference(value: string | undefined): boolean {
  return value !== undefined && ENV_REFERENCE_PATTERN.test(value);
}
