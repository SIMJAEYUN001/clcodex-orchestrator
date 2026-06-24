import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';

const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length',
]);
const INCOMING_AUTH = new Set(['authorization', 'x-api-key', 'api-key']);

function hash(value) { return createHash('sha256').update(value).digest(); }
function same(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function requestBody(request, maxBytes) {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Gateway request body exceeded the size limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function incomingToken(request) {
  const authorization = String(request.headers.authorization || '');
  if (authorization.toLowerCase().startsWith('bearer ')) return authorization.slice(7).trim();
  return String(request.headers['x-api-key'] || request.headers['api-key'] || '').trim();
}

function upstreamHeaders(request, profile, credential) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || INCOMING_AUTH.has(lower) || value == null) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  if (profile.authType === 'bearer') headers.set('authorization', `Bearer ${credential}`);
  else if (profile.authType === 'api-key') headers.set(profile.authHeader || 'x-api-key', credential);
  else if (profile.authType === 'basic') {
    headers.set('authorization', `Basic ${Buffer.from(`${profile.authUsername || ''}:${credential}`, 'utf8').toString('base64')}`);
  } else throw new Error(`Unsupported authentication type: ${profile.authType}`);
  if (profile.protocol === 'anthropic' && !headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
  return headers;
}

function joinUpstream(baseUrl, suffix, search) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/+$/, '');
  const incoming = suffix.startsWith('/') ? suffix : `/${suffix}`;
  base.pathname = `${basePath}${incoming}` || '/';
  base.search = search || '';
  base.hash = '';
  return base;
}

export class ProviderGateway {
  constructor({ networkPolicy, host = '127.0.0.1', port = 0, routeTtlMs = 86_400_000, requestBodyLimit = 32 * 1024 * 1024 }) {
    this.networkPolicy = networkPolicy;
    this.host = host;
    this.port = port;
    this.routeTtlMs = routeTtlMs;
    this.requestBodyLimit = requestBodyLimit;
    this.routes = new Map();
    this.server = null;
    this.origin = null;
    this.cleaner = null;
  }

  async start() {
    if (this.server) return this.origin;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    const address = this.server.address();
    this.origin = `http://${this.host}:${address.port}`;
    this.cleaner = setInterval(() => this.cleanup(), Math.min(this.routeTtlMs, 60_000));
    this.cleaner.unref?.();
    return this.origin;
  }

  createRoute({ profile, credential, sessionId }) {
    if (!this.origin) throw new Error('Provider gateway is not running');
    const routeId = randomBytes(18).toString('base64url');
    const token = randomBytes(32).toString('base64url');
    this.routes.set(routeId, {
      profile: { ...profile },
      credential: String(credential),
      tokenHash: hash(token),
      sessionId,
      lastUsedAt: Date.now(),
    });
    return {
      routeId,
      token,
      baseUrl: `${this.origin}/providers/${routeId}`,
      revoke: () => this.routes.delete(routeId),
    };
  }

  cleanup() {
    const threshold = Date.now() - this.routeTtlMs;
    for (const [id, route] of this.routes) if (route.lastUsedAt < threshold) this.routes.delete(id);
  }

  async handle(request, response) {
    try {
      const parsed = new URL(request.url || '/', this.origin || `http://${this.host}`);
      const match = /^\/providers\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(parsed.pathname);
      if (!match) {
        response.statusCode = 404;
        response.end('Not found');
        return;
      }
      const route = this.routes.get(match[1]);
      const token = incomingToken(request);
      if (!route || !token || !same(hash(token), route.tokenHash)) {
        response.statusCode = 401;
        response.end('Unauthorized');
        return;
      }
      route.lastUsedAt = Date.now();
      const upstream = joinUpstream(route.profile.baseUrl, match[2] || '/', parsed.search);
      await this.networkPolicy.assertAllowed(upstream.origin);
      const body = await requestBody(request, this.requestBodyLimit);
      const upstreamResponse = await fetch(upstream, {
        method: request.method,
        headers: upstreamHeaders(request, route.profile, route.credential),
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(10 * 60_000),
      });
      response.statusCode = upstreamResponse.status;
      response.statusMessage = upstreamResponse.statusText;
      for (const [name, value] of upstreamResponse.headers) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && name.toLowerCase() !== 'set-cookie') response.setHeader(name, value);
      }
      response.setHeader('cache-control', 'no-store');
      if (!upstreamResponse.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstreamResponse.body).on('error', () => response.destroy()).pipe(response);
    } catch (error) {
      if (!response.headersSent) {
        response.statusCode = 502;
        response.setHeader('content-type', 'application/json; charset=utf-8');
      }
      response.end(JSON.stringify({ error: 'provider_gateway_error', message: error instanceof Error ? error.message : String(error) }));
    }
  }

  async close() {
    if (this.cleaner) clearInterval(this.cleaner);
    this.cleaner = null;
    this.routes.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.origin = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

export const __test = { joinUpstream, incomingToken, upstreamHeaders, hash, same };
