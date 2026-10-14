/**
 * Credential redaction for `ui/server` logs and error text.
 *
 * WebSocket and Git URLs carry credentials either in the query string
 * (`/ws?token=…`) or in the userinfo segment
 * (`https://<token>@github.com/owner/repo`). Failure paths echo the full URL in
 * git stderr and in thrown errors, so logging that text verbatim leaks the
 * credential.
 *
 * This is a separate implementation from `src/shared/credentialRedaction.ts`
 * (which serves model input and router events): `ui/` must not import `src/`
 * (architecture boundary), and that module deliberately leaves `?token=` query
 * parameters intact.
 *
 * Patterns are intentionally narrow — only credential-shaped query keys and the
 * userinfo segment are rewritten, so ordinary log prose is preserved.
 */

export const REDACTED = "[REDACTED]";

const CREDENTIAL_QUERY_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "key",
  "secret",
  "password",
];
const QUERY_CREDENTIAL_RE = new RegExp(`([?&](?:${CREDENTIAL_QUERY_KEYS.join("|")})=)[^&\\s"'<>]*`, "gi");
const URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/**
 * Replace credential-shaped substrings in `text` with `[REDACTED]`.
 *
 * @param {unknown} text value to sanitize; non-strings are returned unchanged
 * @returns {unknown} the sanitized string, or `text` itself when not a string
 */
export function redactSecrets(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text.replace(QUERY_CREDENTIAL_RE, `$1${REDACTED}`).replace(URL_USERINFO_RE, `$1${REDACTED}@`);
}
