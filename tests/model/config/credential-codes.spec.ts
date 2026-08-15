/**
 * 凭证双错误码测试（阶段四 T10）。
 *
 * 覆盖：缺失/空值/未设 env 引用 → missing_credential；换行与控制字符 →
 * invalid_credential；正常字面量与 env 引用通过；错误消息不泄漏凭证片段；
 * agent loop 分类路由给出不同提示且均可判别。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyModelError,
  isInvalidCredentialError,
  isMissingCredentialError,
} from "../../../src/agent/loop/modelErrors.js";
import {
  assertUsableCredential,
  CREDENTIAL_INVALID_CODE,
  CREDENTIAL_MISSING_CODE,
  resolveApiKey,
} from "../../../src/model/config/resolveCredentials.js";
import { ModelConfigError } from "../../../src/model/protocol/errors.js";
import type { CanonicalModelError } from "../../../src/model/index.js";

function credentialError(code: string): CanonicalModelError {
  return { provider: "deepseek", protocol: "openai", code, message: "test", retryable: false };
}

test("无配置且无 env：missing_credential", () => {
  assert.throws(
    () => resolveApiKey(undefined, {}),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_MISSING_CODE,
  );
  assert.throws(
    () => resolveApiKey("", {}),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_MISSING_CODE,
  );
});

test("env 引用为空串或未设置：missing_credential", () => {
  assert.throws(
    () => resolveApiKey("${SATI_KEY}", { SATI_KEY: "" }),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_MISSING_CODE,
  );
  assert.throws(
    () => resolveApiKey("${SATI_KEY}", {}),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_MISSING_CODE,
  );
});

test("非法格式：换行与控制字符 → invalid_credential", () => {
  assert.throws(
    () => resolveApiKey("sk-abc\ndef", {}),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_INVALID_CODE,
  );
  assert.throws(
    () => assertUsableCredential("sk-ab\u0001c"),
    (error: unknown) => error instanceof ModelConfigError && error.code === CREDENTIAL_INVALID_CODE,
  );
});

test("正常路径：字面量与 env 引用均通过并 trim", () => {
  assert.equal(resolveApiKey("  sk-literal-123  ", {}), "sk-literal-123");
  assert.equal(resolveApiKey("${SATI_KEY}", { SATI_KEY: "  sk-from-env  " }), "sk-from-env");
});

test("错误消息不泄漏凭证片段", () => {
  try {
    resolveApiKey("sk-secret-with\nlinebreak", {});
    assert.fail("expected invalid_credential");
  } catch (error) {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("sk-secret-with"), false);
  }
});

test("回路路由：两码可判别且提示各异", () => {
  const missing = classifyModelError(credentialError(CREDENTIAL_MISSING_CODE));
  const invalid = classifyModelError(credentialError(CREDENTIAL_INVALID_CODE));
  assert.equal(isMissingCredentialError(credentialError(CREDENTIAL_MISSING_CODE)), true);
  assert.equal(isInvalidCredentialError(credentialError(CREDENTIAL_INVALID_CODE)), true);
  assert.equal(missing.error.userHint?.includes("No API key"), true);
  assert.equal(invalid.error.userHint?.includes("cannot carry"), true);
  assert.notEqual(missing.error.userHint, invalid.error.userHint);
});
