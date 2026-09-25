#!/usr/bin/env node
/**
 * XCrap MCP server — Twitter / X extraction tools over the Model Context Protocol.
 *
 * This is a thin, honest wrapper around the XCrap REST API (https://xcrap.cc/docs).
 * One tool per endpoint, no invented endpoints, no client-side re-shaping of data
 * that the API already shapes. Everything interesting here is about the two things
 * an MCP server actually controls: how many tokens a result costs, and how useful
 * an error is to the model that just caused it.
 *
 * Transport is stdio, so nothing may ever be written to stdout except JSON-RPC
 * frames. All logging goes to stderr. The tools themselves live in `tools.js`,
 * shared with the hosted server at https://xcrap.cc/mcp.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer, parseErrorBody, VERSION, XcrapApiError } from './tools.js';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * The XCrap instance to talk to.
 *
 * Overridable with XCRAP_BASE_URL, for routing requests through a proxy.
 */
const BASE_URL = readBaseUrl();

/**
 * Descriptive User-Agent so XCrap's own request log can separate MCP traffic
 * from browsers and curl. Agent traffic has a different shape — bursty, cache
 * friendly, markdown-hungry — and it is worth being able to see it.
 */
const USER_AGENT = `xcrap-mcp/${VERSION} (+https://xcrap.cc; model-context-protocol; node/${process.versions.node})`;

/** A long history export can take a while; 45s is the real ceiling. */
const REQUEST_TIMEOUT_MS = 45_000;

// ── HTTP client ──────────────────────────────────────────────────────────────

/**
 * Read and validate XCRAP_BASE_URL at startup.
 *
 * A misconfigured base URL is fatal and is worth failing loudly for, but a
 * stack trace in an MCP client's log tells the operator nothing. Fail with the
 * one sentence that fixes it.
 */
function readBaseUrl() {
  try {
    return normaliseBaseUrl(process.env.XCRAP_BASE_URL ?? 'https://xcrap.cc');
  } catch (error) {
    console.error(`xcrap-mcp: ${error.message}`);
    process.exit(1);
  }
}

function normaliseBaseUrl(raw) {
  const value = String(raw).trim().replace(/\/+$/, '');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `XCRAP_BASE_URL is not a valid URL: ${JSON.stringify(raw)}. ` +
        'Expected something like https://xcrap.cc',
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`XCRAP_BASE_URL must be http or https, got ${parsed.protocol}`);
  }
  return value;
}

/**
 * One request to the XCrap API.
 *
 * @param {string} path       Endpoint path, e.g. '/v1/tweet'.
 * @param {object} [options]
 * @param {'GET'|'POST'} [options.method]
 * @param {Record<string, string|number|boolean|undefined|null>} [options.query]
 * @param {unknown} [options.body] JSON body, POST only.
 * @returns {Promise<{ text: string, source: string|null, cache: string|null }>}
 */
async function apiRequest(path, { method = 'GET', query = {}, body } = {}) {
  const url = new URL(`${BASE_URL}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/markdown, application/json;q=0.9, */*;q=0.1',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (cause) {
    const timedOut = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const error = new Error(
      timedOut
        ? `The XCrap instance at ${BASE_URL} did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : `Could not reach the XCrap instance at ${BASE_URL}: ${cause?.message ?? cause}.`,
    );
    error.name = 'XcrapTransportError';
    error.timedOut = timedOut;
    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    const detail = parseErrorBody(text);
    throw new XcrapApiError(response.status, {
      ...detail,
      retryAfter: response.headers.get('retry-after'),
    });
  }

  return {
    text,
    cache: response.headers.get('x-xcrap-cache'),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

const server = createServer({
  apiRequest,
  transportAdvice:
    'Check that the instance is running and that XCRAP_BASE_URL points at it ' + `(currently ${BASE_URL}).`,
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only: stdout carries the JSON-RPC frames.
  console.error(`xcrap-mcp ${VERSION} ready on stdio (base URL: ${BASE_URL})`);
}

main().catch((error) => {
  console.error('xcrap-mcp failed to start:', error);
  process.exit(1);
});
