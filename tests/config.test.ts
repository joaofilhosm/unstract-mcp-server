import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadConfig, upstreamMcpUrl } from '../src/config.js';

describe('loadConfig', () => {
  const valid = {
    UNSTRACT_ORG_NAME: 'org-test',
    UNSTRACT_API_NAME: 'api-test',
    UNSTRACT_API_KEY: '11111111-1111-1111-1111-111111111111',
    MCP_PUBLIC_KEY: 'public-key',
  } as NodeJS.ProcessEnv;

  it('loads a complete configuration', () => {
    const config = loadConfig(valid);
    assert.equal(config.unstractOrgName, 'org-test');
    assert.equal(config.unstractApiName, 'api-test');
    assert.equal(config.unstractBaseUrl, 'https://us-central.unstract.com');
  });

  it('throws when a required variable is missing', () => {
    assert.throws(() => loadConfig({ ...valid, UNSTRACT_API_KEY: undefined }), /UNSTRACT_API_KEY/);
    assert.throws(() => loadConfig({ ...valid, MCP_PUBLIC_KEY: '' }), /MCP_PUBLIC_KEY/);
  });

  it('strips trailing slashes from the base URL', () => {
    const config = loadConfig({ ...valid, UNSTRACT_BASE_URL: 'https://example.com/' });
    assert.equal(config.unstractBaseUrl, 'https://example.com');
  });
});

describe('upstreamMcpUrl', () => {
  it('builds the deployment-scoped MCP endpoint', () => {
    const config = loadConfig({
      UNSTRACT_ORG_NAME: 'acme',
      UNSTRACT_API_NAME: 'invoice-extractor',
      UNSTRACT_API_KEY: 'key',
      MCP_PUBLIC_KEY: 'public',
    } as NodeJS.ProcessEnv);

    assert.equal(
      upstreamMcpUrl(config),
      'https://us-central.unstract.com/deployment/api/acme/invoice-extractor/mcp',
    );
  });
});
