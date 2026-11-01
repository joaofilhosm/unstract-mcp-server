/**
 * MCP request handling: authentication, protocol validation and proxying to the
 * upstream Unstract MCP server.
 */

import type { Request, Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { UnstractMcpClient, UpstreamError, type JsonRpcRequest } from './unstract-client.js';
import type { Config } from './config.js';

/** JSON-RPC error codes (mirrors the Unstract backend's implementation). */
export const JSONRPC_ERRORS = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  TOOL_EXECUTION_ERROR: -32002,
} as const;

/** MCP protocol revisions understood by this server and by Unstract. */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'] as const;
export const PREFERRED_PROTOCOL_VERSION = '2025-06-18';

export const SERVER_INFO = {
  name: 'unstract-mcp-server',
  version: '1.0.0',
} as const;

/** Compares two strings without leaking timing information. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still perform a comparison to keep the timing profile flat.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extracts the bearer token from the Authorization header.
 * Returns null when no well-formed bearer token is present.
 */
export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;

  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) return null;

  const token = match[1]?.trim() ?? '';
  return token.length > 0 ? token : null;
}

/**
 * Verifies the client-supplied public key against the configured one.
 */
export function isAuthorized(req: Request, config: Config): boolean {
  const token = extractBearerToken(req);
  if (!token) return false;
  return safeEqual(token, config.mcpPublicKey);
}

function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function jsonRpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

/**
 * Validates that the incoming body is a well-formed single JSON-RPC request.
 * Batch requests are rejected, matching the Unstract backend behaviour.
 */
export function validateRequest(body: unknown): {
  ok: boolean;
  id: string | number | null;
  request?: JsonRpcRequest;
  error?: Record<string, unknown>;
} {
  if (Array.isArray(body)) {
    return {
      ok: false,
      id: null,
      error: jsonRpcError(
        null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        'Invalid Request',
        'Batch requests are not supported by this server.',
      ),
    };
  }

  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      id: null,
      error: jsonRpcError(null, JSONRPC_ERRORS.INVALID_REQUEST, 'Invalid Request'),
    };
  }

  const candidate = body as Partial<JsonRpcRequest>;

  if (candidate.jsonrpc !== '2.0') {
    return {
      ok: false,
      id: candidate.id ?? null,
      error: jsonRpcError(
        candidate.id ?? null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        'Invalid Request',
        "The 'jsonrpc' field must be exactly '2.0'.",
      ),
    };
  }

  if (typeof candidate.method !== 'string' || candidate.method.length === 0) {
    return {
      ok: false,
      id: candidate.id ?? null,
      error: jsonRpcError(
        candidate.id ?? null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        'Invalid Request',
        "The 'method' field is required and must be a string.",
      ),
    };
  }

  const id = candidate.id ?? null;
  if (id !== null && typeof id !== 'string' && typeof id !== 'number') {
    return {
      ok: false,
      id: null,
      error: jsonRpcError(
        null,
        JSONRPC_ERRORS.INVALID_REQUEST,
        'Invalid Request',
        "The 'id' field must be a string, a number or null.",
      ),
    };
  }

  return {
    ok: true,
    id,
    request: {
      jsonrpc: '2.0',
      id: candidate.id,
      method: candidate.method,
      params: candidate.params,
    },
  };
}

/**
 * Handles `initialize` locally so we can advertise our own server identity and
 * the upstream deployment context while still speaking the exact MCP dialect.
 */
function handleInitializeLocally(request: JsonRpcRequest, config: Config) {
  const params = (request.params ?? {}) as { protocolVersion?: unknown };
  const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : undefined;

  const protocolVersion =
    requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
      ? requested
      : PREFERRED_PROTOCOL_VERSION;

  return {
    protocolVersion,
    capabilities: {
      tools: { listChanged: false },
    },
    serverInfo: SERVER_INFO,
    instructions:
      `This server exposes the Unstract API Deployment "${config.unstractApiName}" ` +
      `(organization "${config.unstractOrgName}") through the Model Context Protocol. ` +
      `It runs LLM-driven extraction over unstructured documents and returns structured JSON. ` +
      `Call readMeFirst before any other tool, then getApiInfo to learn what the deployment extracts. ` +
      `Call extractDocument with HTTPS S3 document URLs, and poll getExecutionStatus with the ` +
      `returned execution_id when the execution is not yet COMPLETED. Never re-run ` +
      `extractDocument after an execution_id was returned — that consumes quota.`,
  };
}

/**
 * Creates the Express handler that serves the MCP endpoint.
 */
export function createMcpHandler(config: Config, client: UnstractMcpClient) {
  return async function mcpHandler(req: Request, res: Response): Promise<void> {
    // --- Authentication -------------------------------------------------
    if (!isAuthorized(req, config)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="unstract-mcp"');
      res.status(401).json(
        jsonRpcError(
          null,
          JSONRPC_ERRORS.UNAUTHORIZED,
          'Invalid API key or unknown API deployment',
          'Provide a valid bearer token in the Authorization header.',
        ),
      );
      return;
    }

    // --- Only POST is meaningful for request/response Streamable HTTP ---
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      res.status(405).json({
        name: SERVER_INFO.name,
        version: SERVER_INFO.version,
        protocolVersion: PREFERRED_PROTOCOL_VERSION,
        transport: 'http',
        authMethods: ['bearer'],
        error: 'Method Not Allowed. Use POST for JSON-RPC requests.',
      });
      return;
    }

    // --- Validate the JSON-RPC envelope --------------------------------
    const validation = validateRequest(req.body);
    if (!validation.ok || !validation.request) {
      res.status(200).json(validation.error);
      return;
    }

    const request = validation.request;
    const id = validation.id;

    // --- Notifications carry no id and expect an empty 202 response -----
    if (request.id === undefined) {
      res.status(202).json({});
      return;
    }

    // --- Local handling for initialize and ping ------------------------
    if (request.method === 'initialize') {
      res.status(200).json(jsonRpcResult(id, handleInitializeLocally(request, config)));
      return;
    }

    if (request.method === 'ping') {
      res.status(200).json(jsonRpcResult(id, {}));
      return;
    }

    // --- Proxy everything else to the upstream Unstract MCP server ------
    try {
      const upstreamResponse = await client.send(request);
      res.status(200).json(upstreamResponse);
    } catch (error) {
      if (error instanceof UpstreamError) {
        // Preserve the upstream status code for auth/rate-limit failures,
        // but translate transport-level failures into JSON-RPC errors.
        if (error.status === 401 || error.status === 403) {
          res.status(error.status).json(
            jsonRpcError(
              id,
              JSONRPC_ERRORS.UNAUTHORIZED,
              'Invalid API key or unknown API deployment',
            ),
          );
          return;
        }

        res.status(200).json(
          jsonRpcError(
            id,
            JSONRPC_ERRORS.TOOL_EXECUTION_ERROR,
            'Upstream request failed',
            error.body ?? error.message,
          ),
        );
        return;
      }

      res.status(200).json(
        jsonRpcError(
          id,
          JSONRPC_ERRORS.INTERNAL_ERROR,
          'Internal error',
          (error as Error).message,
        ),
      );
    }
  };
}
