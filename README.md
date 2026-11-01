# Unstract MCP Server

A public remote [Model Context Protocol](https://modelcontextprotocol.io) server that exposes an
[Unstract](https://github.com/Zipstack/unstract) API Deployment to AI agents.

It runs on **Vercel** as a stateless Streamable HTTP endpoint and is compatible with
**OpenAI** and **Claude** (and any other MCP client that speaks Streamable HTTP).

---

## How it works

The Unstract platform already ships a native MCP server
([`backend/mcp_server/`](https://github.com/Zipstack/unstract/tree/main/backend/mcp_server)).
This project is a **thin, stateless proxy** in front of it:

```
Claude / OpenAI  ──Bearer <MCP_PUBLIC_KEY>──▶  this server (Vercel)
                                                     │
                                                     │ Authorization: Bearer <UNSTRACT_API_KEY>
                                                     ▼
                                    Unstract MCP endpoint
                          /deployment/api/<org>/<api_name>/mcp
```

The Unstract API key lives **only** in the server's environment variables. Clients never see it —
they authenticate with a separate public key you issue. The proxy forwards JSON-RPC envelopes
verbatim and returns the upstream response untouched, so **none** of Unstract's business rules are
reimplemented here:

- S3 pre-signed URL validation
- quota / rate-limit accounting
- input schemas and their validation errors
- the one-shot semantics of a completed extraction result

---

## Tools

| Tool | Purpose |
| --- | --- |
| `readMeFirst` | Instructions and context about the connected deployment. |
| `getApiInfo` | Deployment metadata: display name, API name, workflow, active state. |
| `extractDocument` | Run LLM-driven extraction over document URLs. **Consumes quota.** |
| `getExecutionStatus` | Poll for the result of a pending extraction. |

### `extractDocument` arguments

| Argument | Type | Default | Notes |
| --- | --- | --- | --- |
| `document_urls` | `string[]` | *required* | HTTPS URLs on an AWS S3 host. Use a pre-signed URL for private objects. Max 32 URLs. |
| `timeout` | `integer` | `30` | `-1` to return immediately and poll. Range `-1`–`300` seconds. |
| `include_metadata` | `boolean` | `false` | Include extraction metadata. |
| `include_metrics` | `boolean` | `false` | Include token and cost metrics. |
| `include_extracted_text` | `boolean` | `false` | Include the full raw text (can be very large). |
| `tags` | `string[]` | – | At most **1** tag. |
| `llm_profile_id` | `string` | – | UUID of an LLM profile overriding the deployment default. |

### `getExecutionStatus` arguments

| Argument | Type | Default |
| --- | --- | --- |
| `execution_id` | `string` | *required* |
| `include_metadata` | `boolean` | `false` |
| `include_metrics` | `boolean` | `false` |
| `include_extracted_text` | `boolean` | `false` |

---

## ⚠️ Critical behaviour to respect

1. **`extractDocument` always returns an `execution_id`.** Never re-run it after receiving one —
   every retry consumes quota a second time. Poll with `getExecutionStatus` instead.
2. **A completed result can only be read once.** The first `COMPLETED` poll consumes it; a second
   poll returns *"This result was already acknowledged and is no longer retrievable."*
3. **Documents must already be on S3** and referenced by an HTTPS URL whose host ends in
   `amazonaws.com`. Any other host is rejected. For private objects, generate a pre-signed URL.
4. **`timeout: -1`** runs asynchronously — use it when you intend to poll.

---

## Configuration

Set these environment variables in your Vercel project:

| Variable | Required | Description |
| --- | --- | --- |
| `UNSTRACT_API_KEY` | ✅ | Your Unstract API key (a UUID). Never exposed to clients. |
| `UNSTRACT_ORG_NAME` | ✅ | The `<org>` segment of your deployment REST URL. |
| `UNSTRACT_API_NAME` | ✅ | The `<api_name>` segment of your deployment REST URL. |
| `MCP_PUBLIC_KEY` | ✅ | Bearer token your clients must send to use this server. |
| `UNSTRACT_BASE_URL` | – | Defaults to `https://us-central.unstract.com`. Use `https://eu-central.unstract.com` for EU. |
| `ALLOWED_ORIGINS` | – | Comma-separated CORS origins. Defaults to `*`. |
| `UPSTREAM_TIMEOUT_MS` | – | Upstream request timeout in ms. Defaults to `55000`. |

---

## Client configuration

### Claude Desktop / Claude Code

```bash
claude mcp add --transport http unstract \
  https://<your-deployment>.vercel.app/mcp \
  --header "Authorization: Bearer <MCP_PUBLIC_KEY>"
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "unstract": {
      "type": "http",
      "url": "https://<your-deployment>.vercel.app/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_PUBLIC_KEY>"
      }
    }
  }
}
```

### OpenAI

OpenAI's MCP connector expects an HTTP endpoint with bearer auth:

```json
{
  "mcpServers": {
    "unstract": {
      "type": "http",
      "url": "https://<your-deployment>.vercel.app/mcp",
      "authorization": "Bearer <MCP_PUBLIC_KEY>"
    }
  }
}
```

---

## Endpoints

| Path | Method | Auth | Description |
| --- | --- | --- | --- |
| `/mcp` | `POST` | Bearer | The MCP endpoint (Streamable HTTP, request/response). |
| `/` | `GET` | – | Service identity and protocol information. |
| `/health` | `GET` | – | Health check used by the platform. |

---

## Development with a local mock

A mock of the Unstract MCP endpoint ships with this repo. It reproduces the real
backend's contract (validation rules, the `execution_id` contract, the one-shot
completed-result behaviour) so you can exercise the whole path without credentials.

```bash
npm install
npm run build
npm run dev:mock
```

It prints the MCP endpoint and a ready-to-use bearer token:

```
MCP endpoint : http://localhost:3000/mcp
Bearer token : mock-client-key
```

Then:

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer mock-client-key' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

> The mock returns synthetic extraction results. It exists to validate the proxy,
> not to replace the real platform.

---

## Local development

```bash
npm install
npm test          # 37 unit + integration tests
npm run typecheck
npm run dev
```

To run against the real Unstract backend, export the env vars and start the server:

```bash
export UNSTRACT_API_KEY=<your uuid>
export UNSTRACT_ORG_NAME=<org>
export UNSTRACT_API_NAME=<api name>
export MCP_PUBLIC_KEY=<any secret>
npm run dev
```

Then:

```bash
curl -s http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <MCP_PUBLIC_KEY>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}'
```

---

## Protocol details

- **Transport:** Streamable HTTP, request/response (no SSE).
- **JSON-RPC:** 2.0. Batch requests are rejected with `-32600`.
- **Protocol revisions:** `2025-06-18` (preferred) and `2024-11-05` (accepted).
- **Methods:** `initialize`, `ping`, `tools/list`, `tools/call`.
- **Errors:** JSON-RPC errors are returned with HTTP 200, except authentication which returns a real
  HTTP 401 with a `WWW-Authenticate` header.
- **Tool errors** that the agent can fix are returned as `result.isError = true` (HTTP 200).
- **Unexpected tool errors** use JSON-RPC code `-32002`.

---

## Deployment

This project deploys to Vercel with zero configuration:

- `api/index.ts` is the serverless function entry point.
- `vercel.json` pins `maxDuration: 60` and rewrites `/mcp` → `/api/index`.
- The function is fully **stateless** — no filesystem, no shared state, so it scales horizontally.

```bash
vercel --prod
```

---

## License

MIT — see [LICENSE](./LICENSE).

This project is an independent client of the Unstract API. It is not affiliated with or endorsed
by Zipstack. Unstract itself is licensed under AGPL-3.0.
