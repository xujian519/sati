/**
 * 凭证脱敏原语。两处外发通道共用一份实现：
 *   - 用户输入外发（`src/agent/turn/sanitizeAgentInput.ts`）——含密钥的粘贴内容
 *     不应原样进入远端模型；
 *   - provider 错误信息落盘（`src/router/tokenSaver/classifyAndRoute.ts`）——错误
 *     正文常回显请求里的密钥，`~/.sati/router/events.jsonl` 是明文文件。
 *
 * 正则刻意收窄防误伤：密钥需 ≥16 字符；URL 凭证仅匹配 userinfo 段
 * （scheme://user:pass@host），普通 "a:b@c" 散文不受影响。
 */
export const REDACTED_API_KEY = "[REDACTED_API_KEY]";
export const REDACTED_CREDENTIALS = "[REDACTED_CREDENTIALS]";
export const REDACTED_SECURE_TOKEN = "[REDACTED_SECURE_TOKEN]";

// `glpat[-_]`：GitLab PAT 的真实前缀是连字符（`glpat-`），历史实现写成了下划线，
// 两种都收——只认下划线会漏掉真实令牌，只认连字符则是对既有行为的回归。
const API_KEY_RE = /\b(?:sk-|sk-ant-|xai-|AIza|ghp_|gho_|glpat[-_])[A-Za-z0-9_-]{16,}\b/g;
const URL_CREDENTIALS_RE = /([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi;
const SECRET_ASSIGNMENT_RE = /(password|passwd|secret_key|private_key)(\s*[:=]\s*)(["'])[^"']+\3/gi;

/** 对单段文本执行三类凭证替换；redacted = 文本是否发生变化。 */
export function sanitizeOutgoingText(text: string): { text: string; redacted: boolean } {
  const out = text
    .replace(API_KEY_RE, REDACTED_API_KEY)
    .replace(URL_CREDENTIALS_RE, `$1:${REDACTED_CREDENTIALS}@`)
    .replace(SECRET_ASSIGNMENT_RE, `$1$2$3${REDACTED_SECURE_TOKEN}$3`);
  return { text: out, redacted: out !== text };
}
