/**
 * Integration tests for the MCP proxy.
 *
 * A real Unstract API key is required to reach the live upstream, so these
 * tests run a mock that replicates the exact contract of the Unstract
 * deployment-scoped MCP endpoint:
 *
 *   - POST-only, Streamable HTTP request/response
 *   - protocol revision 2025-06-18
 *   - 401 (real HTTP status) with a JSON-RPC error envelope on bad auth
 *   - JSON-RPC errors returned with HTTP 200
 *   - tool errors reported as `result.isError = true`
 *
 * This validates the proxy end-to-end without needing credentials.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import { createApp } from '../src/server.js';
import type { Config } from '../src/config.js';

const UPSTREAM_KEY = '11111111-1111-1111-1111-111111111111';
const CLIENT_KEY = 'client-public-key';

let upstream: Server;
let upstreamUrl: string;
let app: ReturnType<typeof createApp>;
let server: Server;
let baseUrl: string;

/** Number of extractDocument calls received upstream — used to assert no retry. */
let extractCallCount = 0;

before(async () => {
  upstream = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const auth = req.headers.authorization;
      if (!auth || auth !== `Bearer ${UPSTREAM_KEY}`) {
        res.statusCode = 401;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32001, message: 'Invalid API key or unknown API deployment' },
          }),
        );
        return;
      }

      let body: { id?: number; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
        );
        return;
      }

      const id = body.id ?? null;
      const respond = (payload: unknown) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(payload));
      };

      switch (body.method) {
        case 'tools/list':
          respond({
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'readMeFirst',
                  description: 'Instructions',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'getApiInfo',
                  description: 'Deployment metadata',
                  inputSchema: { type: 'object', properties: {} },
                },
                {
                  name: 'extractDocument',
                  description: 'Extract documents',
                  inputSchema: {
                    type: 'object',
                    properties: { document_urls: { type: 'array', items: { type: 'string' } } },
                    required: ['document_urls'],
                  },
                },
                {
                  name: 'getExecutionStatus',
                  description: 'Poll execution',
                  inputSchema: {
                    type: 'object',
                    properties: { execution_id: { type: 'string' } },
                    required: ['execution_id'],
                  },
                },
              ],
            },
          });
          return;

        case 'tools/call': {
          const toolName = body.params?.name;
          const args = body.params?.arguments ?? {};

          if (toolName === 'readMeFirst') {
            respond({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify({ server: 'Unstract MCP Server' }) }],
                isError: false,
              },
            });
            return;
          }

          if (toolName === 'getApiInfo') {
            respond({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      id: 'api-uuid',
                      display_name: 'Invoice Extractor',
                      api_name: 'invoice-extractor',
                      is_active: true,
                    }),
                  },
                ],
                isError: false,
              },
            });
            return;
          }

          if (toolName === 'extractDocument') {
            extractCallCount += 1;
            const urls = (args.document_urls as string[] | undefined) ?? [];

            // Replicate the upstream S3 pre-signed URL validation.
            if (urls.length === 0) {
              respond({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: 'Invalid arguments: document_urls: This field is required.',
                    },
                  ],
                  isError: true,
                },
              });
              return;
            }

            for (const raw of urls) {
              let parsed: URL | null = null;
              try {
                parsed = new URL(raw);
              } catch {
                parsed = null;
              }
              if (!parsed || parsed.protocol !== 'https:' || !parsed.hostname.endsWith('amazonaws.com')) {
                respond({
                  jsonrpc: '2.0',
                  id,
                  result: {
                    content: [
                      {
                        type: 'text',
                        text: `Invalid arguments: document_urls.0: URL host '${parsed?.hostname ?? raw}' is not a valid S3 endpoint.`,
                      },
                    ],
                    isError: true,
                  },
                });
                return;
              }
            }

            respond({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      execution_id: 'exec-uuid-1234',
                      execution_status: 'COMPLETED',
                      result: [{ file: 'doc.pdf', status: 'Success', result: { output: { total: '42' } } }],
                    }),
                  },
                ],
                isError: false,
              },
            });
            return;
          }

          if (toolName === 'getExecutionStatus') {
            const executionId = args.execution_id;
            if (executionId === 'already-consumed') {
              respond({
                jsonrpc: '2.0',
                id,
                result: {
                  content: [
                    {
                      type: 'text',
                      text: JSON.stringify({
                        execution_status: 'COMPLETED',
                        message:
                          'This result was already acknowledged and is no longer retrievable. Start a new extraction if you need it again.',
                      }),
                    },
                  ],
                  isError: false,
                },
              });
              return;
            }
            respond({
              jsonrpc: '2.0',
              id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({ execution_id: executionId, execution_status: 'PENDING' }),
                  },
                ],
                isError: false,
              },
            });
            return;
          }

          respond({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: 'Method not found',
              data: { available_tools: ['readMeFirst', 'getApiInfo', 'extractDocument', 'getExecutionStatus'] },
            },
          });
          return;
        }

        default:
          respond({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'pong' }], isError: false },
          });
      }
    });
  });

  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (typeof address === 'object' && address) {
    upstreamUrl = `http://127.0.0.1:${address.port}`;
  }

  const config: Config = {
    unstractBaseUrl: upstreamUrl,
    unstractOrgName: 'org-test',
    unstractApiName: 'invoice-extractor',
    unstractApiKey: UPSTREAM_KEY,
    mcpPublicKey: CLIENT_KEY,
    allowedOrigins: ['*'],
    upstreamTimeoutMs: 10_000,
  };

  app = createApp(config);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const srvAddress = server.address();
  if (typeof srvAddress === 'object' && srvAddress) {
    baseUrl = `http://127.0.0.1:${srvAddress.port}`;
  }
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

async function rpc(
  body: unknown,
  auth: string | null = `Bearer ${CLIENT_KEY}`,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

describe('MCP proxy — authentication', () => {
  it('returns 401 with a JSON-RPC envelope when the key is missing', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize' }, null);
    assert.equal(status, 401);
    assert.equal(json.error.code, -32001);
  });

  it('returns 401 when the key is wrong', async () => {
    const { status, json } = await rpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      'Bearer wrong-key',
    );
    assert.equal(status, 401);
    assert.equal(json.error.code, -32001);
  });

  it('sets the WWW-Authenticate header on 401', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate') ?? '', /Bearer/);
  });
});

describe('MCP proxy — protocol', () => {
  it('initializes with the preferred protocol version', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18' },
    });
    assert.equal(status, 200);
    assert.equal(json.result.protocolVersion, '2025-06-18');
    assert.equal(json.result.serverInfo.name, 'unstract-mcp-server');
    assert.ok(json.result.capabilities.tools);
    assert.ok(json.result.instructions.includes('readMeFirst'));
  });

  it('echoes the legacy protocol version 2024-11-05', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    });
    assert.equal(json.result.protocolVersion, '2024-11-05');
  });

  it('falls back to the preferred version for an unsupported revision', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '1999-01-01' },
    });
    assert.equal(json.result.protocolVersion, '2025-06-18');
  });

  it('answers ping', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 2, method: 'ping' });
    assert.equal(status, 200);
    assert.ok(json.result);
  });

  it('rejects batch requests with -32600', async () => {
    const { status, json } = await rpc([
      { jsonrpc: '2.0', id: 1, method: 'ping' },
      { jsonrpc: '2.0', id: 2, method: 'ping' },
    ]);
    assert.equal(status, 200);
    assert.equal(json.error.code, -32600);
  });

  it('returns 202 for notifications', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CLIENT_KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.equal(response.status, 202);
  });

  it('rejects GET with 405 and the server identity', async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      headers: { Authorization: `Bearer ${CLIENT_KEY}` },
    });
    assert.equal(response.status, 405);
    const json = await response.json();
    assert.equal(json.protocolVersion, '2025-06-18');
    assert.equal(json.transport, 'http');
  });
});

describe('MCP proxy — tools', () => {
  it('lists the four Unstract tools', async () => {
    const { status, json } = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    assert.equal(status, 200);
    const names = json.result.tools.map((t: { name: string }) => t.name);
    assert.deepEqual(names, [
      'readMeFirst',
      'getApiInfo',
      'extractDocument',
      'getExecutionStatus',
    ]);
  });

  it('calls readMeFirst', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'readMeFirst', arguments: {} },
    });
    assert.equal(json.result.isError, false);
    assert.match(json.result.content[0].text, /Unstract MCP Server/);
  });

  it('calls getApiInfo', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'getApiInfo', arguments: {} },
    });
    assert.equal(json.result.isError, false);
    assert.match(json.result.content[0].text, /Invoice Extractor/);
  });

  it('calls extractDocument and returns the execution_id', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'extractDocument',
        arguments: {
          document_urls: ['https://my-bucket.s3.us-east-1.amazonaws.com/invoice.pdf?X-Amz-Signature=abc'],
        },
      },
    });
    assert.equal(json.result.isError, false);
    const payload = JSON.parse(json.result.content[0].text);
    assert.equal(payload.execution_id, 'exec-uuid-1234');
    assert.equal(payload.execution_status, 'COMPLETED');
  });

  it('propagates upstream validation errors as isError:true', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'extractDocument',
        arguments: { document_urls: ['https://evil.example.com/doc.pdf'] },
      },
    });
    assert.equal(status, 200);
    assert.equal(json.result.isError, true);
    assert.match(json.result.content[0].text, /not a valid S3 endpoint/);
  });

  it('calls getExecutionStatus', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'getExecutionStatus', arguments: { execution_id: 'exec-uuid-1234' } },
    });
    assert.equal(json.result.isError, false);
    assert.match(json.result.content[0].text, /PENDING/);
  });

  it('surfaces the one-shot "already acknowledged" message', async () => {
    const { json } = await rpc({
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'getExecutionStatus', arguments: { execution_id: 'already-consumed' } },
    });
    assert.equal(json.result.isError, false);
    assert.match(json.result.content[0].text, /already acknowledged/);
  });

  it('returns -32601 for an unknown tool', async () => {
    const { status, json } = await rpc({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    assert.equal(status, 200);
    assert.equal(json.error.code, -32601);
  });
});

describe('MCP proxy — service endpoints', () => {
  it('serves the service identity at the root', async () => {
    const response = await fetch(`${baseUrl}/`);
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.protocolVersion, '2025-06-18');
    assert.equal(json.mcpEndpoint, '/mcp');
  });

  it('serves a health check', async () => {
    const response = await fetch(`${baseUrl}/health`);
    const json = await response.json();
    assert.equal(response.status, 200);
    assert.equal(json.status, 'ok');
  });
});
