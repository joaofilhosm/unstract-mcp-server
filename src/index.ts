#!/usr/bin/env node
/**
 * Entry point. Keeps the process alive when run directly (local dev / Docker).
 * On Vercel the `api/index.ts` handler is used instead.
 */

import { start } from './server.js';

start().catch((error: Error) => {
  console.error('[unstract-mcp] failed to start:', error.message);
  process.exit(1);
});
