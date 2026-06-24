import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { HTML, CSS, APP } from './control-center-assets.js';
import { ORCHESTRATION_PRESETS } from '../orchestration/policy-store.js';
import { ROLES } from '../roles.js';

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

function requiredId(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

export class AdminSetupServer {
  constructor({
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
    this.service = service;
    this.store = store || service?.store || null;
    this.policyStore = policyStore;
    this.specStore = specStore;
    this.harnessRuntime = harnessRuntime;
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
    this.sessions.set(digest(token).toString('hex'), {
      guildId,
      userId,
      threadId,
      expiresAt,
      pending: null,
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
    const { guildId, threadId } = session;
    const providers = this.service.list(guildId);
    const bindings = Object.fromEntries(ROLES.map((role) => [role, {
      global: this.store?.getBinding(guildId, 'global', '*', role) || null,
      thread: threadId ? this.store?.getBinding(guildId, 'thread', threadId, role) || null : null,
      resolved: this.store?.resolveBinding(guildId, threadId, role) || null,
    }]));
    const policies = this.policyStore?.snapshot(guildId, threadId) || {
      policy: { settings: ORCHESTRATION_PRESETS.balanced, scopeType: 'default', revision: 0 },
      roles: {},
      explicit: {},
    };
    const providerAudit = this.store?.listAudit(guildId, 40) || [];
    const policyAudit = this.policyStore?.listAudit(guildId, 40) || [];
    const audits = [...providerAudit.map((item) => ({ ...item, target: item.targetId })), ...policyAudit]
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, 60);
    return {
      ok: true,
      session: {
        guildId,
        userId: session.userId,
        threadId,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      providers,
      bindings,
      policies,
      presetDefinitions: ORCHESTRATION_PRESETS,
      sessions: this.harnessRuntime?.listSessions?.() || [],
      specs: threadId ? this.specStore?.listSpecsForThread(guildId, threadId, 20) || [] : [],
      audits,
    };
  }

  async providerDiscover(authorized, body) {
    const result = await this.service.discover({ ...body, guildId: authorized.value.guildId });
    const initial = String(body.initialModel || '').trim();
    const models = [...result.models];
    if (initial && !models.some((item) => item.modelKey === initial)) {
      models.unshift({ modelKey: initial, displayName: initial, metadata: { source: 'initial' } });
    }
    authorized.value.pending = { ...body, guildId: authorized.value.guildId, models };
    return { ok: true, status: result.status, latencyMs: result.latencyMs, models };
  }

  async providerCreate(authorized, body) {
    if (!authorized.value.pending) throw new Error('먼저 연결 테스트 및 모델 조회를 실행하세요.');
    const pending = authorized.value.pending;
    const configured = await this.service.createConfigured({
      ...pending,
      selectedModels: body.selectedModels,
      bindings: body.bindings,
      scopeType: authorized.value.threadId ? 'thread' : 'global',
      scopeId: authorized.value.threadId || '*',
    }, authorized.value.userId);
    authorized.value.pending = null;
    return { ok: true, provider: configured.provider };
  }

  async providerAction(pathname, authorized, body) {
    const providerId = requiredId(body.providerId, 'providerId');
    if (pathname.endsWith('/test')) {
      const result = await this.service.test(providerId);
      return { ok: true, ...result, message: `연결 성공 · HTTP ${result.status} · ${result.latencyMs}ms · 모델 ${result.modelCount}개` };
    }
    if (pathname.endsWith('/sync')) {
      const result = await this.service.sync(providerId, authorized.value.userId);
      return { ok: true, ...result, message: `모델 ${result.models.length}개를 동기화했습니다.` };
    }
    if (pathname.endsWith('/toggle')) {
      const current = this.store.requireProfile(providerId);
      const updated = await this.service.update(providerId, { enabled: !current.enabled }, authorized.value.userId);
      return { ok: true, provider: updated, message: updated.enabled ? '공급자를 활성화했습니다.' : '공급자를 비활성화했습니다.' };
    }
    if (pathname.endsWith('/delete')) {
      this.store.deleteProfile(providerId, authorized.value.userId);
      return { ok: true, message: '공급자와 연결된 모델 바인딩을 삭제했습니다.' };
    }
    throw new Error('Unsupported provider action');
  }

  saveBinding(authorized, body) {
    if (!this.policyStore) throw new Error('Runtime policy store is unavailable');
    const guildId = authorized.value.guildId;
    const role = requiredId(body.role, 'role');
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
    const scopeType = body.scopeType === 'thread' ? 'thread' : 'global';
    const scopeId = scopeType === 'thread'
      ? requiredId(authorized.value.threadId && body.scopeId === authorized.value.threadId ? body.scopeId : '', 'current thread scope')
      : '*';
    const providerId = requiredId(body.providerId, 'providerId');
    const modelKey = requiredId(body.modelKey, 'modelKey');
    const profile = this.store.requireProfile(providerId);
    if (profile.guildId !== guildId) throw new Error('Provider belongs to another server');
    if (profile.harness !== body.harness) throw new Error('Selected provider does not match the selected harness');
    const binding = this.service.bind({ guildId, scopeType, scopeId, role, providerId, modelKey }, authorized.value.userId);
    const existing = this.policyStore.getRoleSettings(guildId, scopeType, scopeId, role)?.settings || {};
    const settings = {
      ...existing,
      [profile.harness]: {
        ...(existing[profile.harness] || {}),
        ...(body.runtimeSettings?.[profile.harness] || {}),
      },
    };
    const runtime = this.policyStore.setRoleSettings({ guildId, scopeType, scopeId, role, settings }, authorized.value.userId);
    return { ok: true, binding, runtime };
  }

  savePolicy(authorized, body) {
    if (!this.policyStore) throw new Error('Orchestration policy store is unavailable');
    const scopeType = body.scopeType === 'thread' ? 'thread' : 'global';
    const scopeId = scopeType === 'thread'
      ? requiredId(authorized.value.threadId && body.scopeId === authorized.value.threadId ? body.scopeId : '', 'current thread scope')
      : '*';
    const policy = this.policyStore.setPolicy({
      guildId: authorized.value.guildId,
      scopeType,
      scopeId,
      settings: body.settings,
    }, authorized.value.userId);
    return { ok: true, policy };
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
        if (request.method === 'GET' && url.pathname === '/api/bootstrap') {
          json(response, 200, this.bootstrap(authorized.value));
          return;
        }
        if (request.method !== 'POST') {
          json(response, 405, { ok: false, error: 'Method not allowed' });
          return;
        }
        const body = await jsonBody(request);
        let result;
        if (url.pathname === '/api/providers/discover' || url.pathname === '/api/discover') {
          result = await this.providerDiscover(authorized, body);
        } else if (url.pathname === '/api/providers/create' || url.pathname === '/api/save') {
          result = await this.providerCreate(authorized, body);
        } else if (/^\/api\/providers\/(test|sync|toggle|delete)$/.test(url.pathname)) {
          result = await this.providerAction(url.pathname, authorized, body);
        } else if (url.pathname === '/api/bindings/save') {
          result = this.saveBinding(authorized, body);
        } else if (url.pathname === '/api/policy/save') {
          result = this.savePolicy(authorized, body);
        } else {
          json(response, 404, { ok: false, error: 'API route not found' });
          return;
        }
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
    this.sessions.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve) => server.close(resolve));
  }
}

export const __test = { HTML, CSS, APP, digest, jsonBody };
