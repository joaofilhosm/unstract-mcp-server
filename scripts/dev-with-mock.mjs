#!/usr/bin/env node
/**
 * Convenience script: starts the mock Unstract upstream and the MCP proxy
 * wired to it, so you can exercise the whole flow locally without any
 * credentials.
 *
 * Usage:
 *   npm run dev:mock
 *
 * Then point an MCP client at http://localhost:3000/mcp with the bearer token
 * printed below.
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const MOCK_KEY = 'mock-upstream-key';
const CLIENT_KEY = 'mock-client-key';
const MOCK_PORT = 4111;
const APP_PORT = 3000;

const children = [];

function start(name, command, args, env) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`[${name}] exited with code ${code}`);
      shutdown(1);
    }
  });
  children.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

console.log('[dev:mock] starting the mock Unstract upstream...');
start('mock', process.execPath, ['scripts/mock-unstract.mjs', '--port', String(MOCK_PORT)], {
  MOCK_API_KEY: MOCK_KEY,
});

setTimeout(() => {
  console.log('[dev:mock] starting the MCP proxy...');
  start('proxy', process.execPath, ['dist/index.js'], {
    UNSTRACT_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
    UNSTRACT_ORG_NAME: 'mock-org',
    UNSTRACT_API_NAME: 'mock-invoice-extractor',
    UNSTRACT_API_KEY: MOCK_KEY,
    MCP_PUBLIC_KEY: CLIENT_KEY,
    PORT: String(APP_PORT),
  });

  setTimeout(() => {
    console.log('');
    console.log('  MCP endpoint : http://localhost:' + APP_PORT + '/mcp');
    console.log('  Bearer token : ' + CLIENT_KEY);
    console.log('');
    console.log('  Example:');
    console.log(`    curl -s http://localhost:${APP_PORT}/mcp \\`);
    console.log(`      -H 'Content-Type: application/json' \\`);
    console.log(`      -H 'Authorization: Bearer ${CLIENT_KEY}' \\`);
    console.log(`      -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`);
    console.log('');
  }, 1200);
}, 800);
