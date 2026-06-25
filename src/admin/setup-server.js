import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { apiRouteToMethod } from '../../shared/admin-protocol.js';
import { HTML, CSS, APP } from './control-center-assets.js';
import { AdminControlPlane } from './control-plane.js';

function digest(value) { return createHash('sha256').update(value).digest(); }
function same(a, b) { return a.length === b.length && timingSafeEqual(a, b); }

async function jsonBody(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function json(response, status, body) {
  response.statusCode = status;
  response.end(JSON.stringify(body));
}

export class AdminSetupServer {
  constructor({
    controlPlane = null,
    service,
    store = null,
    policyStore = null,
    specStore = null,
    harnessRuntime = null,
    host = '127.0.0.1',
    port = 8787,
    publicUrl = null,
    sessionTtlMs = 600_000,
    frameAncestors = "'none'",
  }) {
    this.controlPlane = controlPlane || new AdminControlPlane({
      service,
      store,
      policyStore,
      specStore,
      harnessRuntime,
      sessionTtlMs,
    });
    this.host = host;
    this.port = port;
    this.publicUrl = publicUrl;
    this.sessionTtlMs = sessionTtlMs;
    this.frameAncestors = frameAncestors;
    this.sessions = new Map();
    this.server = null;
    this.origin = null;
  }

  async start() {
    if (this.server) return this.origin;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    const address = this.server.address();
    this.origin = this.publicUrl || `http://${this.host}:${address.port}`;
    return this.origin;
  }

  issueSession({ guildId, userId, threadId = null }) {
    if (!this.origin) throw new Error('Admin setup server is not running');
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.sessionTtlMs;
    const controlSessionId = this.controlPlane.openSession({
      guildId,
      userId,
      threadId,
      expiresAt,
      transport: 'legacy-loopback',
    });
    this.sessions.set(digest(token).toString('hex'), {
      guildId,
      userId,
      threadId,
      expiresAt,
      controlSessionId,
    });
    return {
      url: `${this.origin.replace(/\/$/, '')}/admin#token=${encodeURIComponent(token)}`,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  session(request) {
    const auth = String(request.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const candidate = digest(token);
    for (const [key, value] of this.sessions) {
      if (!same(candidate, Buffer.from(key, 'hex'))) continue;
      if (value.expiresAt < Date.now()) {
        this.sessions.delete(key);
        this.controlPlane.closeSession(value.controlSessionId);
        return null;
      }
      return { key, value };
    }
    return null;
  }

  security(response, contentType) {
    response.setHeader('content-type', contentType);
    response.setHeader('cache-control', 'no-store, max-age=0');
    response.setHeader('x-content-type-options', 'nosniff');
    if (this.frameAncestors === "'none'") response.setHeader('x-frame-options', 'DENY');
    response.setHeader('referrer-policy', 'no-referrer');
    response.setHeader(
      'content-security-policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors ${this.frameAncestors}; base-uri 'none'`,
    );
  }

  authorize(request, response) {
    const authorized = this.session(request);
    if (!authorized) {
      json(response, 401, { ok: false, error: '관리 세션이 만료되었거나 유효하지 않습니다.' });
      return null;
    }
    return authorized;
  }

  bootstrap(session) {
    return this.controlPlane.bootstrap(this.controlPlane.requireSession(session.controlSessionId));
  }

  async handle(request, response) {
    try {
      const url = new URL(request.url || '/', 'http://localhost');
      if (request.method === 'GET' && ['/', '/setup', '/admin'].includes(url.pathname)) {
        this.security(response, 'text/html; charset=utf-8');
        response.end(HTML);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/style.css') {
        this.security(response, 'text/css; charset=utf-8');
        response.end(CSS);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/app.js') {
        this.security(response, 'text/javascript; charset=utf-8');
        response.end(APP);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        this.security(response, 'application/json; charset=utf-8');
        const authorized = this.authorize(request, response);
        if (!authorized) return;
        const method = apiRouteToMethod(url.pathname, request.method);
        if (!method) {
          json(response, request.method === 'GET' ? 404 : 405, { ok: false, error: 'API route not found' });
          return;
        }
        const body = request.method === 'GET' ? {} : await jsonBody(request);
        const result = await this.controlPlane.invoke(authorized.value.controlSessionId, method, body);
        json(response, 200, result);
        return;
      }
      response.statusCode = 404;
      response.end('Not found');
    } catch (error) {
      this.security(response, 'application/json; charset=utf-8');
      json(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async close() {
    for (const session of this.sessions.values()) this.controlPlane.closeSession(session.controlSessionId);
    this.sessions.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

export const __test = { HTML, CSS, APP, digest, jsonBody };
