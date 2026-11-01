/**
 * Environment configuration.
 *
 * The public MCP server holds the Unstract API key on the server side so that
 * end users never need their own Unstract credentials. Clients authenticate
 * with a separate public key (MCP_PUBLIC_KEY) issued by the operator.
 */

export interface Config {
  /** Base URL of the Unstract platform, e.g. https://us-central.unstract.com */
  unstractBaseUrl: string;
  /** Unstract organization name (the `<org>` segment of the REST URL). */
  unstractOrgName: string;
  /** API Deployment name (the `<api_name>` segment of the REST URL). */
  unstractApiName: string;
  /** Unstract API key (UUID) used to authenticate against the upstream deployment. */
  unstractApiKey: string;
  /** Bearer key clients must present to use this public MCP server. */
  mcpPublicKey: string;
  /** Comma-separated list of allowed origins for browser-based MCP clients. */
  allowedOrigins: string[];
  /** Upstream request timeout in milliseconds. */
  upstreamTimeoutMs: number;
}

const DEFAULTS = {
  upstreamTimeoutMs: 55_000,
  baseUrl: 'https://us-central.unstract.com',
};

function required(name: string, value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Set it in your Vercel project settings before deploying.`,
    );
  }
  return trimmed;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Reads and validates configuration from `process.env`.
 * Throws a descriptive error when required variables are missing.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const baseUrl = stripTrailingSlash(env.UNSTRACT_BASE_URL?.trim() || DEFAULTS.baseUrl);

  const allowedOrigins = (env.ALLOWED_ORIGINS ?? '*')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  return {
    unstractBaseUrl: baseUrl,
    unstractOrgName: required('UNSTRACT_ORG_NAME', env.UNSTRACT_ORG_NAME),
    unstractApiName: required('UNSTRACT_API_NAME', env.UNSTRACT_API_NAME),
    unstractApiKey: required('UNSTRACT_API_KEY', env.UNSTRACT_API_KEY),
    mcpPublicKey: required('MCP_PUBLIC_KEY', env.MCP_PUBLIC_KEY),
    allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : ['*'],
    upstreamTimeoutMs: Number(env.UPSTREAM_TIMEOUT_MS ?? DEFAULTS.upstreamTimeoutMs) || DEFAULTS.upstreamTimeoutMs,
  };
}

/**
 * Builds the fully-qualified upstream MCP endpoint for the configured deployment.
 */
export function upstreamMcpUrl(config: Config): string {
  const base = stripTrailingSlash(config.unstractBaseUrl);
  return `${base}/deployment/api/${config.unstractOrgName}/${config.unstractApiName}/mcp`;
}
