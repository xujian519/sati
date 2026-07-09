import { describe, expect, it } from 'vitest';
import { normalizeModelError } from './normalizeModelError.js';

function codeFor(message: string): string {
  return normalizeModelError('test', 'openai', new Error(message)).code;
}

describe('normalizeModelError network classification', () => {
  it('classifies common network failures', () => {
    expect(codeFor('getaddrinfo ENOTFOUND api.test')).toBe('dns_error');
    expect(codeFor('read ECONNRESET')).toBe('connection_reset');
    expect(codeFor('connect ECONNREFUSED 127.0.0.1:443')).toBe('connection_refused');
    expect(codeFor('certificate has expired')).toBe('tls_error');
    expect(codeFor('proxy CONNECT failed')).toBe('proxy_error');
  });
});
