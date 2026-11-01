#!/usr/bin/env node
/**
 * Development mock of the Unstract deployment-scoped MCP endpoint.
 *
 * It reproduces the contract of the real Unstract backend
 * (`backend/mcp_server/` in Zipstack/unstract) closely enough to exercise the
 * full proxy path locally — including the validation rules, the quota-safe
 * `execution_id` contract and the one-shot completed-result behaviour.
 *
 * It is NOT a substitute for the real platform: extraction results are
 * synthetic. Use the real Unstract deployment for production traffic.
 *
 * Usage:
 *   node scripts/mock-unstract.mjs [--port 4000]
 *
 * Auth: any bearer token is accepted when MOCK_API_KEY is unset, otherwise the
 * token must match MOCK_API_KEY exactly.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const args = process.argv.slice(2);
const portIndex = args.indexOf('--port');
const PORT = portIndex >= 0 ? Number(args[portIndex + 1]) : Number(process.env.MOCK_PORT ?? 4000);
const API_KEY = process.env.MOCK_API_KEY ?? '';

const PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'];

/** execution_id -> execution record */
const executions = new Map();
/** execution_ids whose COMPLETED result has already been acknowledged */
const consumed = new Set();

const SERVER_INFO = {
  name: 'unstract',
  version: '0.1.0',
  protocolVersion: PROTOCOL_VERSION,
  transport: 'http',
  authMethods: ['bearer'],
};

function jsonRpcError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function toolResult(id, payload, isError = false) {
  return jsonRpcResult(id, {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError,
  });
}

function validatePresignedUrls(urls) {
  if (!Array.isArray(urls) || urls.length === 0) {
    return 'document_urls: This field is required.';
  }
  if (urls.length > 32) {
    return 'document_urls: Ensure this field has no more than 32 items.';
  }
  for (const raw of urls) {
    let parsed;
    try {
      parsed = new URL(raw);
    } catch {
      return `document_urls: Enter a valid URL.`;
    }
    if (parsed.protocol !== 'https:') {
      return `document_urls: Only HTTPS presigned URLs are allowed. URL scheme found: ${parsed.protocol.replace(':', '')}`;
    }
    const host = parsed.hostname;
    const looksLikeS3 =
      host === 's3.amazonaws.com' ||
      host.endsWith('.s3.amazonaws.com') ||
      host.endsWith('.amazonaws.com') ||
      /^s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(host);
    if (!looksLikeS3) {
      return `document_urls: URL host '${host}' is not a valid S3 endpoint. Only S3 pre-signed URLs are supported currently.`;
    }
  }
  return null;
}

const TOOLS = [
  {
    name: 'readMeFirst',
    title: 'readMeFirst',
    description: 'Read this first. Returns instructions and context for the connected Unstract deployment.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'readMeFirst', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'getApiInfo',
    title: 'getApiInfo',
    description: 'Get metadata about the connected Unstract API deployment.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'getApiInfo', readOnlyHint: true, openWorldHint: true },
  },
  {
    name: 'extractDocument',
    title: 'extractDocument',
    description:
      'Extract structured data from one or more documents referenced by HTTPS S3 URLs. Always returns an execution_id. Never retry after receiving one — poll getExecutionStatus instead.',
    inputSchema: {
      type: 'object',
      properties: {
        document_urls: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 32,
          description:
            'HTTPS URLs of the documents to extract. The host must be an AWS S3 endpoint (*.amazonaws.com); other hosts are rejected. Use a pre-signed URL for a private object.',
        },
        timeout: {
          type: 'integer',
          minimum: -1,
          maximum: 300,
          default: 30,
          description: 'Seconds to wait before returning a pending result. Use -1 to return immediately and poll.',
        },
        include_metadata: { type: 'boolean', default: false },
        include_metrics: { type: 'boolean', default: false },
        include_extracted_text: { type: 'boolean', default: false },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 1 },
        llm_profile_id: { type: 'string' },
      },
      required: ['document_urls'],
    },
    annotations: {
      title: 'extractDocument',
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  {
    name: 'getExecutionStatus',
    title: 'getExecutionStatus',
    description:
      'Poll the status of a previous extraction. A COMPLETED result can only be read once; a second poll returns "already acknowledged".',
    inputSchema: {
      type: 'object',
      properties: {
        execution_id: { type: 'string' },
        include_metadata: { type: 'boolean', default: false },
        include_metrics: { type: 'boolean', default: false },
        include_extracted_text: { type: 'boolean', default: false },
      },
      required: ['execution_id'],
    },
    annotations: { title: 'getExecutionStatus', readOnlyHint: false, openWorldHint: true },
  },
];

function buildReadMeFirst() {
  return {
    server: 'Unstract MCP Server',
    connected_deployment: {
      name: 'Mock Invoice Extractor',
      description: 'Extracts invoice fields (development mock)',
      is_active: true,
    },
    what_this_does:
      'Unstract runs LLM-driven extraction over unstructured documents and returns structured JSON. This MCP server is scoped to a single API deployment.',
    tools: [
      { name: 'getApiInfo', purpose: 'Learn what the connected deployment extracts.' },
      { name: 'extractDocument', purpose: 'Run extraction over document URLs. Consumes quota.' },
      { name: 'getExecutionStatus', purpose: 'Poll for the result of a pending extraction.' },
    ],
    recommended_workflow: [
      '1. Call getApiInfo to confirm the deployment is active.',
      '2. Call extractDocument with the URL(s) of the document(s).',
      '3. If the response has execution_status COMPLETED, you are done.',
      '4. Otherwise poll getExecutionStatus with the returned execution_id.',
    ],
    notes: [
      'extractDocument consumes the extraction quota. Never call it speculatively, and never retry a call that already returned an execution_id — poll instead.',
    ],
    mock: true,
  };
}

function buildApiInfo() {
  return {
    id: 'mock-api-uuid',
    display_name: 'Mock Invoice Extractor',
    api_name: 'mock-invoice-extractor',
    description: 'Extracts invoice fields (development mock)',
    is_active: true,
    workflow: { id: 'mock-workflow-uuid', name: 'mock-workflow' },
  };
}

function buildExtractionResult(url, includeMetadata, includeMetrics, includeExtractedText) {
  const file = decodeURIComponent(url.split('/').pop()?.split('?')[0] ?? 'document.pdf');

  const entry = {
    file,
    status: 'Success',
    result: {
      output: {
        invoice_number: 'INV-2026-0001',
        invoice_date: '2026-01-15',
        total_amount: '1234.56',
        currency: 'USD',
        vendor_name: 'Acme Corporation',
      },
    },
  };

  if (includeMetadata) {
    entry.metadata = {
      source_name: file,
      source_hash: randomUUID().replace(/-/g, ''),
      organization_id: 'mock-org',
      workflow_id: 'mock-workflow-uuid',
      execution_id: 'pending',
      total_elapsed_time: 1.42,
      tool_metadata: [{ tool_name: 'extract', elapsed_time: '1.42', output_type: 'JSON' }],
    };
  }
  if (includeMetrics) {
    entry.metrics = { prompt_tokens: 1820, completion_tokens: 240, total_tokens: 2060, cost_usd: 0.0123 };
  }
  if (includeExtractedText) {
    entry.extracted_text = `MOCK EXTRACTED TEXT for ${file}\n\nInvoice Number: INV-2026-0001\nTotal: 1234.56 USD\n`;
  }

  return entry;
}

function handleToolCall(id, name, args) {
  switch (name) {
    case 'readMeFirst':
      return toolResult(id, buildReadMeFirst());

    case 'getApiInfo':
      return toolResult(id, buildApiInfo());

    case 'extractDocument': {
      const urls = args?.document_urls;
      const validationError = validatePresignedUrls(urls);
      if (validationError) {
        return toolResult(id, `Invalid arguments: ${validationError}`, true);
      }

      const timeout = args?.timeout === undefined ? 30 : Number(args.timeout);
      if (!Number.isInteger(timeout) || timeout < -1 || timeout > 300) {
        return toolResult(id, 'Invalid arguments: timeout: Ensure this value is at most 300.', true);
      }
      if (args?.tags && args.tags.length > 1) {
        return toolResult(id, 'Invalid arguments: tags: Ensure this field has no more than 1 item.', true);
      }

      const executionId = randomUUID();
      const includeMetadata = args?.include_metadata === true;
      const includeMetrics = args?.include_metrics === true;
      const includeExtractedText = args?.include_extracted_text === true;

      const result = urls.map((url) =>
        buildExtractionResult(url, includeMetadata, includeMetrics, includeExtractedText),
      );

      // timeout -1 (or 0) means asynchronous: the result is not immediately ready.
      const isAsync = timeout <= 0;
      const status = isAsync ? 'PENDING' : 'COMPLETED';

      executions.set(executionId, {
        executionId,
        status,
        result,
        createdAt: Date.now(),
        tags: args?.tags ?? [],
      });

      const payload = {
        execution_id: executionId,
        execution_status: status,
        status_api: `/deployment/api/mock-org/mock-invoice-extractor/?execution_id=${executionId}`,
        error: null,
        result: isAsync ? [] : result,
      };

      return toolResult(id, payload);
    }

    case 'getExecutionStatus': {
      const executionId = args?.execution_id;
      if (!executionId) {
        return toolResult(id, 'Invalid arguments: execution_id: This field is required.', true);
      }

      const execution = executions.get(executionId);
      if (!execution) {
        return toolResult(id, `Execution ${executionId} not found.`, true);
      }

      if (consumed.has(executionId)) {
        return toolResult(id, {
          execution_status: 'COMPLETED',
          message:
            'This result was already acknowledged and is no longer retrievable. Start a new extraction if you need it again.',
        });
      }

      // The mock marks an async execution as ready after a short delay.
      if (execution.status === 'PENDING' && Date.now() - execution.createdAt > 1500) {
        execution.status = 'COMPLETED';
      }

      if (execution.status === 'COMPLETED') {
        consumed.add(executionId);
        return toolResult(id, {
          execution_id: executionId,
          execution_status: 'COMPLETED',
          result: execution.result,
        });
      }

      return toolResult(id, {
        execution_id: executionId,
        execution_status: execution.status,
        result: [],
      });
    }

    default:
      return jsonRpcError(id, -32601, 'Method not found', {
        available_tools: TOOLS.map((t) => t.name),
      });
  }
}

const server = createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const auth = req.headers.authorization ?? '';
    const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1]?.trim() ?? '';

    if (!token || (API_KEY && token !== API_KEY)) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('WWW-Authenticate', 'Bearer realm="unstract-mcp"');
      res.end(
        JSON.stringify(
          jsonRpcError(null, -32001, 'Invalid API key or unknown API deployment'),
        ),
      );
      return;
    }

    if (req.method === 'GET') {
      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(SERVER_INFO));
      return;
    }

    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
      return;
    }

    if (Array.isArray(body)) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify(
          jsonRpcError(null, -32600, 'Invalid Request', 'Batch requests are not supported.'),
        ),
      );
      return;
    }

    const id = body?.id ?? null;
    let response;

    if (body?.jsonrpc !== '2.0' || typeof body?.method !== 'string') {
      response = jsonRpcError(id, -32600, 'Invalid Request');
    } else if (body.id === undefined) {
      res.statusCode = 202;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({}));
      return;
    } else if (body.method === 'initialize') {
      const requested = body.params?.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : PROTOCOL_VERSION;
      response = jsonRpcResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'unstract', version: '0.1.0' },
        instructions:
          "Unstract runs LLM-driven extraction over unstructured documents and returns structured JSON. This server is scoped to the API deployment 'Mock Invoice Extractor'. Call readMeFirst before any other tool.",
      });
    } else if (body.method === 'ping') {
      response = jsonRpcResult(id, {});
    } else if (body.method === 'tools/list') {
      response = jsonRpcResult(id, { tools: TOOLS });
    } else if (body.method === 'tools/call') {
      const name = body.params?.name;
      const args = body.params?.arguments ?? {};
      if (!name || !TOOLS.some((t) => t.name === name)) {
        response = jsonRpcError(id, -32601, 'Method not found', {
          available_tools: TOOLS.map((t) => t.name),
        });
      } else {
        response = handleToolCall(id, name, args);
      }
    } else {
      response = jsonRpcError(id, -32601, 'Method not found');
    }

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(response));
  });
});

server.listen(PORT, () => {
  console.log(`[mock-unstract] listening on :${PORT} — MCP endpoint at /deployment/api/mock-org/mock-invoice-extractor/mcp`);
  console.log(`[mock-unstract] auth: ${API_KEY ? 'bearer token required' : 'any bearer token accepted'}`);
});
