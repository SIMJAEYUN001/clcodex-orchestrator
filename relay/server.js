import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { ADMIN_PROTOCOL_VERSION, assertProtocolMessage } from '../shared/admin-protocol.js';

function hash(value) {
  return createHash('sha256').update(String(value)).digest();
}

function equalSecret(expected, candidate) {
  const left = hash(expected);
  const right = hash(candidate);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(request) {
  const value = String(request.headers.authorization || '');
  return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}

function sendJson(response, status, value, origin = null) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store, max-age=0');
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'no-referrer');
  if (origin) {
    response.setHeader('access-control-allow-origin', origin);
    response.setHeader('vary', 'origin');
  }
  response.end(JSON.stringify(value));
}

async function bodyJson(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function safeClose(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, String(reason).slice(0, 120));
  }
}

function wsSend(socket, value, maxPayloadBytes) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > maxPayloadBytes) throw new Error('Relay payload exceeds the configured limit');
  socket.send(encoded);
}

function identifier(value, label, max = 128) {
  const result = String(value || '').trim();
  if (!result || result.length > max) throw new Error(`${label} is invalid`);
  return result;
}

function oauthRedirectUri(value, allowedOrigins) {
  if (!value) return null;
  let url;
  try { url = new URL(String(value)); } catch { throw new Error('OAuth redirect_uri is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('OAuth redirect_uri must be an HTTPS URL without credentials, query, or fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('OAuth redirect_uri path is not allowed');
  if (!allowedOrigins.includes(url.origin)) throw new Error('OAuth redirect_uri origin is not allowed');
  return url.origin;
}

class RateWindow {
  constructor(limit) {
    this.limit = limit;
    this.startedAt = Date.now();
    this.count = 0;
  }

  consume() {
    const now = Date.now();
    if (now - this.startedAt >= 60_000) {
      this.startedAt = now;
      this.count = 0;
    }
    this.count += 1;
    if (this.count > this.limit) throw new Error('Relay message rate limit exceeded');
  }
}

export class AdminRelayServer {
  constructor(config, { fetchImpl = fetch, logger = console } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.logger = logger;
    this.httpServer = null;
    this.deviceWss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes, perMessageDeflate: false });
    this.activityWss = new WebSocketServer({ noServer: true, maxPayload: config.maxPayloadBytes, perMessageDeflate: false });
    this.devices = new Map();
    this.oauthSessions = new Map();
    this.sessions = new Map();
    this.sweepTimer = null;
  }

  allowedOrigin(request) {
    const origin = String(request.headers.origin || '');
    return this.config.activityOrigins.includes(origin) ? origin : null;
  }

  async exchangeOAuth(code, redirectUri = null) {
    const params = new URLSearchParams({
      client_id: this.config.discordClientId,
      client_secret: this.config.discordClientSecret,
      grant_type: 'authorization_code',
      code: identifier(code, 'OAuth code', 2048),
    });
    const effectiveRedirectUri = oauthRedirectUri(redirectUri, this.config.activityOrigins);
    if (effectiveRedirectUri) params.set('redirect_uri', effectiveRedirectUri);
    const tokenResponse = await this.fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params,
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!tokenResponse.ok) throw new Error(`Discord OAuth token exchange failed with HTTP ${tokenResponse.status}`);
    const token = await tokenResponse.json();
    if (!token.access_token) throw new Error('Discord OAuth response did not include an access token');
    const userResponse = await this.fetch('https://discord.com/api/v10/users/@me', {
      headers: { authorization: `Bearer ${token.access_token}` },
      redirect: 'error',
      signal: AbortSignal.timeout(12_000),
    });
    if (!userResponse.ok) throw new Error(`Discord user lookup failed with HTTP ${userResponse.status}`);
    const user = await userResponse.json();
    return { token, user };
  }

  createOauthSession(user) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + this.config.oauthSessionTtlMs;
    this.oauthSessions.set(hash(token).toString('hex'), {
      userId: identifier(user.id, 'Discord user ID', 32),
      user: { id: user.id, username: user.username, global_name: user.global_name || null, avatar: user.avatar || null },
      expiresAt,
    });
    return { token, expiresAt };
  }

  consumeOauthSession(token) {
    const key = hash(token).toString('hex');
    const session = this.oauthSessions.get(key);
    this.oauthSessions.delete(key);
    if (!session || session.expiresAt <= Date.now()) return null;
    return session;
  }

  async handleHttp(request, response) {
    try {
      const url = new URL(request.url || '/', 'http://relay.invalid');
      const origin = this.allowedOrigin(request);
      if (request.method === 'OPTIONS') {
        if (!origin) return sendJson(response, 403, { ok: false, error: 'Origin is not allowed' });
        response.statusCode = 204;
        response.setHeader('access-control-allow-origin', origin);
        response.setHeader('access-control-allow-methods', 'POST, OPTIONS');
        response.setHeader('access-control-allow-headers', 'content-type');
        response.setHeader('access-control-max-age', '600');
        response.setHeader('vary', 'origin');
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          devices: [...this.devices.values()].filter((entry) => entry.socket.readyState === WebSocket.OPEN).length,
          sessions: this.sessions.size,
        });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/oauth/token') {
        if (!origin) return sendJson(response, 403, { ok: false, error: 'Origin is not allowed' });
        const input = await bodyJson(request, 32_768);
        const { token, user } = await this.exchangeOAuth(input.code, input.redirectUri);
        const relay = this.createOauthSession(user);
        sendJson(response, 200, {
          ok: true,
          access_token: token.access_token,
          token_type: token.token_type || 'Bearer',
          expires_in: token.expires_in,
          relay_session_token: relay.token,
          relay_session_expires_at: new Date(relay.expiresAt).toISOString(),
          user,
        }, origin);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'Not found' }, origin);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, this.allowedOrigin(request));
    }
  }

  handleUpgrade(request, socket, head) {
    try {
      const url = new URL(request.url || '/', 'http://relay.invalid');
      if (url.pathname === '/v1/device') {
        const installationId = identifier(url.searchParams.get('installation_id'), 'installation_id');
        const expected = this.config.devices.get(installationId);
        if (!expected || !equalSecret(expected, bearer(request))) throw new Error('Device authentication failed');
        this.deviceWss.handleUpgrade(request, socket, head, (webSocket) => {
          this.acceptDevice(webSocket, installationId);
        });
        return;
      }
      if (url.pathname === '/v1/activity') {
        if (!this.allowedOrigin(request)) throw new Error('Activity origin is not allowed');
        const installationId = identifier(url.searchParams.get('installation_id'), 'installation_id');
        const oauth = this.consumeOauthSession(url.searchParams.get('session'));
        if (!oauth) throw new Error('Activity OAuth relay session is missing or expired');
        if (!this.devices.has(installationId)) throw new Error('The target orchestrator device is offline');
        this.activityWss.handleUpgrade(request, socket, head, (webSocket) => {
          this.acceptActivity(webSocket, installationId, oauth);
        });
        return;
      }
      throw new Error('Unknown WebSocket endpoint');
    } catch (error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      this.logger.warn?.('Relay upgrade rejected:', error instanceof Error ? error.message : String(error));
    }
  }

  acceptDevice(socket, installationId) {
    const previous = this.devices.get(installationId);
    if (previous) safeClose(previous.socket, 4001, 'replaced by a newer device connection');
    const entry = { installationId, socket, hello: false, rate: new RateWindow(this.config.maxMessagesPerMinute) };
    this.devices.set(installationId, entry);
    socket.on('message', (data) => void this.onDeviceMessage(entry, data));
    socket.on('close', () => this.dropDevice(entry));
    socket.on('error', (error) => this.logger.warn?.('Relay device socket error:', error.message));
  }

  async onDeviceMessage(device, data) {
    try {
      device.rate.consume();
      const message = assertProtocolMessage(JSON.parse(data.toString('utf8')));
      if (!device.hello) {
        if (message.type !== 'device.hello' || message.installationId !== device.installationId) throw new Error('Expected device.hello');
        device.hello = true;
        device.metadata = message.device || null;
        wsSend(device.socket, {
          version: ADMIN_PROTOCOL_VERSION,
          type: 'relay.ready',
          installationId: device.installationId,
          serverTime: new Date().toISOString(),
        }, this.config.maxPayloadBytes);
        return;
      }
      const session = this.sessions.get(String(message.sessionId || ''));
      if (!session || session.device !== device) throw new Error('Unknown activity relay session');
      if (message.type === 'activity.accept' || message.type === 'activity.reject' || message.type === 'rpc.response') {
        wsSend(session.activity.socket, message, this.config.maxPayloadBytes);
        if (message.type === 'activity.reject') this.closeSession(session.id, 4003, 'device rejected Activity');
        return;
      }
      if (message.type === 'device.session.closed') {
        this.closeSession(session.id, 1000, message.reason || 'device closed session');
        return;
      }
      throw new Error(`Unsupported device message: ${message.type}`);
    } catch (error) {
      this.logger.warn?.('Relay device message rejected:', error instanceof Error ? error.message : String(error));
      safeClose(device.socket, 4002, 'invalid device message');
    }
  }

  acceptActivity(socket, installationId, oauth) {
    const activity = {
      socket,
      installationId,
      oauth,
      hello: false,
      rate: new RateWindow(this.config.maxMessagesPerMinute),
      sessionId: null,
    };
    socket.on('message', (data) => void this.onActivityMessage(activity, data));
    socket.on('close', () => {
      if (activity.sessionId) this.closeSession(activity.sessionId, 1000, 'Activity disconnected');
    });
    socket.on('error', (error) => this.logger.warn?.('Relay Activity socket error:', error.message));
  }

  async onActivityMessage(activity, data) {
    try {
      activity.rate.consume();
      const message = assertProtocolMessage(JSON.parse(data.toString('utf8')));
      if (!activity.hello) {
        if (message.type !== 'activity.hello') throw new Error('Expected activity.hello');
        const guildId = identifier(message.guildId, 'guildId', 32);
        const userId = identifier(message.userId, 'userId', 32);
        const channelId = message.channelId ? identifier(message.channelId, 'channelId', 32) : null;
        if (userId !== activity.oauth.userId) throw new Error('Discord OAuth user does not match Activity user');
        const device = this.devices.get(activity.installationId);
        if (!device?.hello || device.socket.readyState !== WebSocket.OPEN) throw new Error('Orchestrator device is unavailable');
        const sessionId = randomUUID();
        const expiresAt = Date.now() + this.config.activitySessionTtlMs;
        const session = { id: sessionId, installationId: activity.installationId, guildId, channelId, userId, expiresAt, device, activity };
        activity.hello = true;
        activity.sessionId = sessionId;
        this.sessions.set(sessionId, session);
        wsSend(device.socket, {
          version: ADMIN_PROTOCOL_VERSION,
          type: 'activity.open',
          sessionId,
          guildId,
          channelId,
          userId,
          expiresAt,
          clientPublicKey: message.clientPublicKey,
        }, this.config.maxPayloadBytes);
        return;
      }
      const session = this.sessions.get(activity.sessionId);
      if (!session || session.activity !== activity) throw new Error('Activity session is unavailable');
      if (message.type !== 'rpc.request' || message.sessionId !== session.id) throw new Error('Unsupported Activity message');
      wsSend(session.device.socket, message, this.config.maxPayloadBytes);
    } catch (error) {
      this.logger.warn?.('Relay Activity message rejected:', error instanceof Error ? error.message : String(error));
      safeClose(activity.socket, 4002, 'invalid Activity message');
    }
  }

  dropDevice(device) {
    if (this.devices.get(device.installationId) === device) this.devices.delete(device.installationId);
    for (const session of [...this.sessions.values()]) {
      if (session.device === device) this.closeSession(session.id, 4004, 'orchestrator device disconnected');
    }
  }

  closeSession(sessionId, code = 1000, reason = 'closed') {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    try {
      if (session.device.socket.readyState === WebSocket.OPEN) {
        wsSend(session.device.socket, {
          version: ADMIN_PROTOCOL_VERSION,
          type: 'activity.close',
          sessionId,
          reason,
        }, this.config.maxPayloadBytes);
      }
    } catch {
      // Device is already gone.
    }
    safeClose(session.activity.socket, code, reason);
  }

  sweep() {
    const now = Date.now();
    for (const [key, session] of this.oauthSessions) if (session.expiresAt <= now) this.oauthSessions.delete(key);
    for (const session of [...this.sessions.values()]) if (session.expiresAt <= now) this.closeSession(session.id, 4005, 'session expired');
  }

  async start() {
    if (this.httpServer) return;
    this.httpServer = http.createServer((request, response) => void this.handleHttp(request, response));
    this.httpServer.on('upgrade', (request, socket, head) => this.handleUpgrade(request, socket, head));
    await new Promise((resolve, reject) => {
      this.httpServer.once('error', reject);
      this.httpServer.listen(this.config.port, this.config.host, resolve);
    });
    this.sweepTimer = setInterval(() => this.sweep(), 15_000);
    this.sweepTimer.unref?.();
  }

  address() {
    return this.httpServer?.address() || null;
  }

  async close() {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    for (const session of [...this.sessions.values()]) this.closeSession(session.id, 1001, 'relay shutting down');
    for (const device of this.devices.values()) safeClose(device.socket, 1001, 'relay shutting down');
    this.devices.clear();
    this.oauthSessions.clear();
    const server = this.httpServer;
    this.httpServer = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    this.deviceWss.close();
    this.activityWss.close();
  }
}
