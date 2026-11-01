/**
 * Thin JSON-RPC client for the Unstract deployment-scoped MCP endpoint.
 *
 * The Unstract backend already implements the full MCP protocol, including
 * input validation, S3 pre-signed URL checks, quota accounting and the
 * one-shot semantics of completed results. This client deliberately does NOT
 * reimplement any of those rules — it forwards JSON-RPC envelopes verbatim and
 * returns the upstream response untouched.
 */

import { upstreamMcpUrl, type Config } from './config.js';

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: unknown;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export class UpstreamError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `Upstream Unstract MCP returned HTTP ${status}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
  }
}

export interface UpstreamCallOptions {
  /** Abort the upstream request after this many milliseconds. */
  timeoutMs?: number;
}

export class UnstractMcpClient {
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(
    private readonly config: Config,
    options: { endpoint?: string; timeoutMs?: number } = {},
  ) {
    this.endpoint = options.endpoint ?? upstreamMcpUrl(config);
    this.timeoutMs = options.timeoutMs ?? config.upstreamTimeoutMs;
  }

  get url(): string {
    return this.endpoint;
  }

  /**
   * Forwards a JSON-RPC envelope to the upstream Unstract MCP endpoint.
   *
   * Returns the parsed JSON-RPC response. Throws `UpstreamError` when the
   * upstream responds with a non-2xx HTTP status (e.g. 401 for a bad key).
   */
  async send(payload: JsonRpcRequest, options: UpstreamCallOptions = {}): Promise<JsonRpcResponse> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.config.unstractApiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok) {
        let parsed: unknown = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch {
          // Keep the raw text when it is not valid JSON.
        }
        throw new UpstreamError(response.status, parsed);
      }

      if (!text) {
        return { jsonrpc: '2.0', id: payload.id ?? null, result: {} };
      }

      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch (error) {
        throw new UpstreamError(
          response.status,
          text,
          `Upstream returned a non-JSON response: ${(error as Error).message}`,
        );
      }
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if ((error as Error).name === 'AbortError') {
        throw new UpstreamError(
          504,
          null,
          `Upstream Unstract MCP request timed out after ${timeoutMs}ms`,
        );
      }
      throw new UpstreamError(
        502,
        null,
        `Failed to reach upstream Unstract MCP: ${(error as Error).message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
