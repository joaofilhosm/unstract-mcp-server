import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractBearerToken,
  isAuthorized,
  validateRequest,
  JSONRPC_ERRORS,
} from '../src/mcp-handler.js';
import type { Config } from '../src/config.js';

const config: Config = {
  unstractBaseUrl: 'https://us-central.unstract.com',
  unstractOrgName: 'org-test',
  unstractApiName: 'api-test',
  unstractApiKey: '11111111-1111-1111-1111-111111111111',
  mcpPublicKey: 'super-secret-public-key',
  allowedOrigins: ['*'],
  upstreamTimeoutMs: 5000,
};

function req(auth?: string) {
  return { headers: auth ? { authorization: auth } : {} } as never;
}

describe('extractBearerToken', () => {
  it('extracts a bearer token', () => {
    assert.equal(extractBearerToken(req('Bearer abc123')), 'abc123');
  });

  it('is case-insensitive on the scheme', () => {
    assert.equal(extractBearerToken(req('bearer abc123')), 'abc123');
  });

  it('returns null for missing or malformed headers', () => {
    assert.equal(extractBearerToken(req()), null);
    assert.equal(extractBearerToken(req('Basic abc')), null);
    assert.equal(extractBearerToken(req('Bearer')), null);
  });
});

describe('isAuthorized', () => {
  it('accepts the correct public key', () => {
    assert.equal(isAuthorized(req('Bearer super-secret-public-key'), config), true);
  });

  it('rejects a wrong key', () => {
    assert.equal(isAuthorized(req('Bearer wrong'), config), false);
  });

  it('rejects a missing key', () => {
    assert.equal(isAuthorized(req(), config), false);
  });

  it('rejects a key of a different length without throwing', () => {
    assert.equal(isAuthorized(req('Bearer short'), config), false);
  });
});

describe('validateRequest', () => {
  it('accepts a valid JSON-RPC request', () => {
    const result = validateRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(result.ok, true);
    assert.equal(result.id, 1);
    assert.equal(result.request?.method, 'tools/list');
  });

  it('rejects batch requests with -32600', () => {
    const result = validateRequest([{ jsonrpc: '2.0', id: 1, method: 'ping' }]);
    assert.equal(result.ok, false);
    assert.equal((result.error?.error as { code: number }).code, JSONRPC_ERRORS.INVALID_REQUEST);
  });

  it('rejects a wrong jsonrpc version', () => {
    const result = validateRequest({ jsonrpc: '1.0', id: 1, method: 'ping' });
    assert.equal(result.ok, false);
    assert.equal((result.error?.error as { code: number }).code, JSONRPC_ERRORS.INVALID_REQUEST);
  });

  it('rejects a missing method', () => {
    const result = validateRequest({ jsonrpc: '2.0', id: 1 });
    assert.equal(result.ok, false);
  });

  it('rejects a non-object body', () => {
    assert.equal(validateRequest('hello').ok, false);
    assert.equal(validateRequest(null).ok, false);
  });

  it('keeps a notification without an id valid', () => {
    const result = validateRequest({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.equal(result.ok, true);
    assert.equal(result.request?.id, undefined);
  });
});
