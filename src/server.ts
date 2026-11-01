import type { IncomingMessage, ServerResponse } from 'node:http';
/**
 * HTTP server exposing the MCP endpoint.
 */

import express, { type Express, type Request, type Response } from 'express';
import { loadConfig, upstreamMcpUrl, type Config } from './config.js';
import { UnstractMcpClient } from './unstract-client.js';
import { createMcpHandler, SERVER_INFO, PREFERRED_PROTOCOL_VERSION } from './mcp-handler.js';

/**
 * Builds the Express application. Exported separately from `start()` so tests
 * can mount the app without binding a port.
 */
export function createApp(config: Config): Express {
  const app = express();
  const client = new UnstractMcpClient(config);
  const handler = createMcpHandler(config, client);

  // The MCP protocol uses JSON request/response bodies only (no multipart),
  // so a standard JSON parser is sufficient.
  app.use(express.json({ limit: '4mb' }));

  // Permissive CORS so browser-based MCP clients can connect directly.
  app.use((req: Request, res: Response, next: () => void) => {
    const allowAll = config.allowedOrigins.includes('*');
    const origin = req.headers.origin;
    const allowed = config.allowedOrigins[0] ?? '*';
    res.setHeader('Access-Control-Allow-Origin', allowAll ? '*' : (origin ?? allowed));
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, MCP-Protocol-Version, Accept, Last-Event-ID',
    );
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Protocol-Version, WWW-Authenticate');

    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // --- Service identity endpoint (public, no auth) -------------------
  app.get('/', (_req: Request, res: Response) => {
    res.json({
      name: SERVER_INFO.name,
      version: SERVER_INFO.version,
      protocolVersion: PREFERRED_PROTOCOL_VERSION,
      transport: 'http',
      authMethods: ['bearer'],
      mcpEndpoint: '/mcp',
      upstream: upstreamMcpUrl(config),
    });
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', version: SERVER_INFO.version });
  });

  // --- The MCP endpoint ------------------------------------------------
  app.all('/mcp', handler);
  app.all('/mcp/', handler);

  // Convenience alias so the root path also works as an MCP endpoint.
  app.post('/', handler);

  // --- Error handler ---------------------------------------------------
  app.use((err: Error, _req: Request, res: Response, _next: () => void) => {
    const isParseError = err instanceof SyntaxError && 'body' in err;
    res.status(isParseError ? 200 : 500).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: isParseError ? -32700 : -32603,
        message: isParseError ? 'Parse error' : 'Internal error',
      },
    });
  });

  return app;
}

/**
 * Starts the HTTP server. Used for local runs and `npm start`.
 */
export async function start(): Promise<void> {
  const config = loadConfig();
  const app = createApp(config);

  const port = Number(process.env.PORT ?? 3000);
  app.listen(port, () => {
    console.log(
      `[unstract-mcp] listening on :${port} — upstream ${upstreamMcpUrl(config)}`,
    );
  });
}

/**
 * Serverless handler. The Vercel Node runtime treats this module's default
 * export as the request handler when the project uses the `node` framework.
 */
export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const app = createApp(loadConfig());

  return new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };

    app(req as never, res as never, () => {
      if (!res.headersSent) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Not Found' }));
      }
      done();
    });

    res.on('finish', done);
    res.on('close', done);
  });
}
