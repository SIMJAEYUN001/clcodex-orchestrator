import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';

function digest(token) {
  return createHash('sha256').update(token).digest();
}

function safeEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(request, limit = 1_000_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Tool payload exceeds size limit');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export class CommandToolServer {
  constructor({ onCommand, host = '127.0.0.1', port = 0 }) {
    this.onCommand = onCommand;
    this.host = host;
    this.port = port;
    this.tokens = new Map();
    this.server = null;
    this.baseUrl = null;
  }

  async listen() {
    if (this.server) return this.baseUrl;
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, resolve);
    });
    const address = this.server.address();
    this.baseUrl = `http://${this.host}:${address.port}`;
    return this.baseUrl;
  }

  register(context) {
    if (!this.baseUrl) throw new Error('Command tool server is not listening');
    const token = randomBytes(32).toString('base64url');
    const key = digest(token).toString('hex');
    this.tokens.set(key, { context: Object.freeze({ ...context }), createdAt: Date.now() });
    return {
      token,
      environment: {
        CLCODEX_TOOL_URL: `${this.baseUrl}/command`,
        CLCODEX_TOOL_TOKEN: token,
      },
    };
  }

  revoke(token) {
    if (!token) return;
    this.tokens.delete(digest(token).toString('hex'));
  }

  authorize(token) {
    if (!token) return null;
    const candidate = digest(token);
    for (const [key, value] of this.tokens) {
      if (safeEqual(candidate, Buffer.from(key, 'hex'))) return value.context;
    }
    return null;
  }

  async handle(request, response) {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    try {
      if (request.method !== 'POST' || request.url !== '/command') {
        response.statusCode = 404;
        response.end(JSON.stringify({ ok: false, error: 'Not found' }));
        return;
      }
      const authorization = String(request.headers.authorization || '');
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const context = this.authorize(token);
      if (!context) throw new Error('Invalid or expired tool token');
      const body = await readJson(request);
      const command = String(body.command || '').trim();
      if (!command) throw new Error('Tool command is required');
      const result = await this.onCommand({ command, payload: body.payload || {}, context });
      response.statusCode = 200;
      response.end(JSON.stringify({ ok: true, result }));
    } catch (error) {
      response.statusCode = 400;
      response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  }

  async close() {
    this.tokens.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    this.baseUrl = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

export const __test = { digest, safeEqual, readJson };
