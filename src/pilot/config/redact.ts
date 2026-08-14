// 敏感字段名匹配（两段式）：
// (a) 敏感词元 + key 结尾——apiKey/api_key/secret_key/accessKey/privateKey/clientKey/refreshKey；
// (b) 原结尾敏感词——apiKeyRaw/authorization/cookie/token/secret/password/credential。
// apiKeySource（"literal"/"env" 来源标记，非敏感）不匹配，避免诊断输出把来源也抹掉。
const SECRET_KEY_PATTERN =
  /(?:api|access|secret|private|client|refresh)[_-]?key$|(?:api[_-]?keyRaw|authorization|cookie|token|secret|password|credential)$/i;

/** `${VAR}` 环境引用不含敏感信息，脱敏时原样保留变量名。 */
const ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export function redactConfig(value: unknown): unknown {
  return redactValue(value, undefined);
}

function redactValue(value: unknown, key: string | undefined): unknown {
  if (key && SECRET_KEY_PATTERN.test(key)) {
    // apiKeyRaw 为 `${VAR}` 引用时保留变量名；字面量才脱敏。
    if (typeof value === "string" && ENV_REFERENCE_PATTERN.test(value.trim())) return value.trim();
    return "<redacted>";
  }

  if (Array.isArray(value)) {
    return value.map(item => redactValue(item, undefined));
  }

  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      output[entryKey] = redactValue(entryValue, entryKey);
    }
    return output;
  }

  return value;
}
