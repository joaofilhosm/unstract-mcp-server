/**
 * Vercel Serverless Function entry point.
 *
 * Stateless by design: every invocation creates a fresh client and holds no
 * state between requests, so the function scales horizontally without any
 * shared storage.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApp } from '../src/server.js';
import { loadConfig } from '../src/config.js';

export const config = {
  runtime: 'nodejs',
  maxDuration: 60,
};

let cachedApp: ReturnType<typeof createApp> | null = null;
let cachedConfig: ReturnType<typeof loadConfig> | null = null;

function getApp() {
  if (!cachedApp) {
    cachedConfig = loadConfig();
    cachedApp = createApp(cachedConfig);
  }
  return cachedApp;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  const app = getApp();
  return new Promise<void>((resolve) => {
    app(req as never, res as never, () => {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not Found' }));
      resolve();
    });
    res.on('finish', () => resolve());
    res.on('close', () => resolve());
  });
}
