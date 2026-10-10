import { describe, expect, it } from "vitest";
import { redactSecrets } from "./redactSecrets.js";

describe("redactSecrets", () => {
  it("redacts credential-shaped query parameters", () => {
    expect(redactSecrets("/ws?token=abc123")).toBe("/ws?token=[REDACTED]");
    expect(redactSecrets("/ws?foo=1&token=abc123&bar=2")).toBe("/ws?foo=1&token=[REDACTED]&bar=2");
    expect(redactSecrets("https://host/p?api_key=xyz")).toBe("https://host/p?api_key=[REDACTED]");
  });

  it("redacts URL userinfo credentials in both shapes", () => {
    expect(redactSecrets("https://ghp_secrettoken@github.com/owner/repo.git")).toBe(
      "https://[REDACTED]@github.com/owner/repo.git",
    );
    expect(redactSecrets("https://user:secret@example.com/path")).toBe("https://[REDACTED]@example.com/path");
  });

  it("redacts a real git clone failure line end to end", () => {
    const stderr =
      "fatal: unable to access 'https://ghp_secrettoken@github.com/owner/repo.git/': The requested URL returned error: 403";
    const out = redactSecrets(stderr);
    expect(out).not.toContain("ghp_secrettoken");
    expect(out).toContain("github.com/owner/repo.git");
    expect(out).toContain("403");
  });

  it("leaves credential-free text untouched", () => {
    expect(redactSecrets("mattermost: ws error: Error: connect ECONNREFUSED 127.0.0.1:1")).toBe(
      "mattermost: ws error: Error: connect ECONNREFUSED 127.0.0.1:1",
    );
    expect(redactSecrets("")).toBe("");
  });

  it("returns non-strings unchanged so it can wrap unknown values", () => {
    expect(redactSecrets(undefined)).toBeUndefined();
    expect(redactSecrets(null)).toBeNull();
    expect(redactSecrets(42)).toBe(42);
  });
});
