/**
 * URL 凭证脱敏（日志面）测试。
 *
 * 覆盖：query 凭证参数、userinfo 两种形态、真实 git 失败行、无误伤，以及
 * 与 `sanitizeOutgoingText` 的分工边界（后者刻意保留 query 原样）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REDACTED_CREDENTIALS,
  redactUrlCredentials,
  sanitizeOutgoingText,
} from "../../src/shared/credentialRedaction.js";

test("redactUrlCredentials：query 凭证参数被替换，其余参数保留", () => {
  assert.equal(redactUrlCredentials("/ws?token=abc123"), `/ws?token=${REDACTED_CREDENTIALS}`);
  assert.equal(redactUrlCredentials("/ws?foo=1&token=abc123&bar=2"), `/ws?foo=1&token=${REDACTED_CREDENTIALS}&bar=2`);
  assert.equal(redactUrlCredentials("https://h/p?api_key=xyz"), `https://h/p?api_key=${REDACTED_CREDENTIALS}`);
});

test("redactUrlCredentials：userinfo 两种形态均被替换", () => {
  assert.equal(
    redactUrlCredentials("ws://host/api/v4/websocket"), // 无凭证不动
    "ws://host/api/v4/websocket",
  );
  assert.equal(
    redactUrlCredentials("https://tokenonly@github.com/o/r"),
    `https://${REDACTED_CREDENTIALS}@github.com/o/r`,
  );
  assert.equal(
    redactUrlCredentials("https://user:secret@example.com/p"),
    `https://${REDACTED_CREDENTIALS}@example.com/p`,
  );
});

test("redactUrlCredentials：ws 畸形 URL 抛出的错误正文不再含 token", () => {
  const raw = "mattermost: ws connect failed: SyntaxError: Invalid URL: not-a-url?token=SECRETTOKEN_abcdef0123456789";
  const out = redactUrlCredentials(raw);
  assert.equal(out.includes("SECRETTOKEN_abcdef0123456789"), false);
  assert.equal(out.includes(`token=${REDACTED_CREDENTIALS}`), true);
});

test("redactUrlCredentials：真实 git clone 失败行端到端", () => {
  const stderr =
    "fatal: unable to access 'https://ghp_secrettoken@github.com/owner/repo.git/': The requested URL returned error: 403";
  const out = redactUrlCredentials(stderr);
  assert.equal(out.includes("ghp_secrettoken"), false);
  assert.equal(out.includes("github.com/owner/repo.git"), true);
  assert.equal(out.includes("403"), true);
});

test("redactUrlCredentials：不误伤无凭证文本与散文冒号", () => {
  assert.equal(redactUrlCredentials("connect ECONNREFUSED 127.0.0.1:1"), "connect ECONNREFUSED 127.0.0.1:1");
  assert.equal(redactUrlCredentials("参见 a:b@c 与 10:30@home"), "参见 a:b@c 与 10:30@home");
});

test("分工边界：sanitizeOutgoingText 保持 query 原样（模型入参语义不变）", () => {
  const { text } = sanitizeOutgoingText("请访问 https://h/p?token=abc123");
  assert.equal(text.includes("abc123"), true);
});
