/**
 * Vercel serverless function entry point.
 *
 * Stateless by design: every invocation reuses a module-level Express app
 * (which holds no request state) and keeps no state between requests, so the
 * function scales horizontally without shared storage.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

let cachedApp: ReturnType<typeof createApp> | null = null;

function getApp() {
  if (!cachedApp) {
    cachedApp = createApp(loadConfig());
  }
  return cachedApp;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = getApp();

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
