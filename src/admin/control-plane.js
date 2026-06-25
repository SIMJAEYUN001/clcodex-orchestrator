import { randomUUID } from 'node:crypto';
import { assertRpcMethod } from '../../shared/admin-protocol.js';
import { ORCHESTRATION_PRESETS } from '../orchestration/policy-store.js';
import { ROLES } from '../roles.js';

function requiredId(value, label) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${label} is required`);
  return result;
}

export class AdminControlPlane {
  constructor({
    service,
    store = null,
    policyStore = null,
    specStore = null,
    harnessRuntime = null,
    sessionTtlMs = 300_000,
  }) {
    this.service = service;
    this.store = store || service?.store || null;
    this.policyStore = policyStore;
    this.specStore = specStore;
    this.harnessRuntime = harnessRuntime;
    this.sessionTtlMs = sessionTtlMs;
    this.sessions = new Map();
  }

  openSession({ guildId, userId, threadId = null, expiresAt = null, transport = 'unknown', metadata = {} }) {
    const now = Date.now();
    const deadline = expiresAt ? new Date(expiresAt).getTime() : now + this.sessionTtlMs;
    if (!Number.isFinite(deadline) || deadline <= now) throw new Error('Admin session expiration is invalid');
    const id = randomUUID();
    this.sessions.set(id, {
      id,
      guildId: requiredId(guildId, 'guildId'),
      userId: requiredId(userId, 'userId'),
      threadId: threadId ? String(threadId) : null,
      expiresAt: Math.min(deadline, now + this.sessionTtlMs),
      transport,
      metadata: { ...metadata },
      pendingProvider: null,
    });
    return id;
  }

  requireSession(sessionId) {
    this.sweep();
    const session = this.sessions.get(String(sessionId || ''));
    if (!session) throw new Error('Admin control session is missing or expired');
    return session;
  }

  touch(sessionId) {
    return this.requireSession(sessionId);
  }

  closeSession(sessionId) {
    this.sessions.delete(String(sessionId || ''));
  }

  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
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
        transport: session.transport,
        e2ee: session.transport === 'activity-relay',
        deviceFingerprint: session.metadata.deviceFingerprint || null,
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

  async providerDiscover(session, body) {
    const result = await this.service.discover({ ...body, guildId: session.guildId });
    const initial = String(body.initialModel || '').trim();
    const models = [...result.models];
    if (initial && !models.some((item) => item.modelKey === initial)) {
      models.unshift({ modelKey: initial, displayName: initial, metadata: { source: 'initial' } });
    }
    session.pendingProvider = { ...body, guildId: session.guildId, models };
    return { ok: true, status: result.status, latencyMs: result.latencyMs, models };
  }

  async providerCreate(session, body) {
    if (!session.pendingProvider) throw new Error('먼저 연결 테스트 및 모델 조회를 실행하세요.');
    const pending = session.pendingProvider;
    const configured = await this.service.createConfigured({
      ...pending,
      selectedModels: body.selectedModels,
      bindings: body.bindings,
      scopeType: session.threadId ? 'thread' : 'global',
      scopeId: session.threadId || '*',
    }, session.userId);
    session.pendingProvider = null;
    return { ok: true, provider: configured.provider };
  }

  async providerAction(method, session, body) {
    const providerId = requiredId(body.providerId, 'providerId');
    if (method === 'providers.test') {
      const result = await this.service.test(providerId);
      return { ok: true, ...result, message: `연결 성공 · HTTP ${result.status} · ${result.latencyMs}ms · 모델 ${result.modelCount}개` };
    }
    if (method === 'providers.sync') {
      const result = await this.service.sync(providerId, session.userId);
      return { ok: true, ...result, message: `모델 ${result.models.length}개를 동기화했습니다.` };
    }
    if (method === 'providers.toggle') {
      const current = this.store.requireProfile(providerId);
      const updated = await this.service.update(providerId, { enabled: !current.enabled }, session.userId);
      return { ok: true, provider: updated, message: updated.enabled ? '공급자를 활성화했습니다.' : '공급자를 비활성화했습니다.' };
    }
    if (method === 'providers.delete') {
      this.store.deleteProfile(providerId, session.userId);
      return { ok: true, message: '공급자와 연결된 모델 바인딩을 삭제했습니다.' };
    }
    throw new Error(`Unsupported provider action: ${method}`);
  }

  saveBinding(session, body) {
    if (!this.policyStore) throw new Error('Runtime policy store is unavailable');
    const guildId = session.guildId;
    const role = requiredId(body.role, 'role');
    if (!ROLES.includes(role)) throw new Error(`Unknown role: ${role}`);
    const scopeType = body.scopeType === 'thread' ? 'thread' : 'global';
    const scopeId = scopeType === 'thread'
      ? requiredId(session.threadId && body.scopeId === session.threadId ? body.scopeId : '', 'current thread scope')
      : '*';
    const providerId = requiredId(body.providerId, 'providerId');
    const modelKey = requiredId(body.modelKey, 'modelKey');
    const profile = this.store.requireProfile(providerId);
    if (profile.guildId !== guildId) throw new Error('Provider belongs to another server');
    if (profile.harness !== body.harness) throw new Error('Selected provider does not match the selected harness');
    const binding = this.service.bind({ guildId, scopeType, scopeId, role, providerId, modelKey }, session.userId);
    const existing = this.policyStore.getRoleSettings(guildId, scopeType, scopeId, role)?.settings || {};
    const settings = {
      ...existing,
      [profile.harness]: {
        ...(existing[profile.harness] || {}),
        ...(body.runtimeSettings?.[profile.harness] || {}),
      },
    };
    const runtime = this.policyStore.setRoleSettings({ guildId, scopeType, scopeId, role, settings }, session.userId);
    return { ok: true, binding, runtime };
  }

  savePolicy(session, body) {
    if (!this.policyStore) throw new Error('Orchestration policy store is unavailable');
    const scopeType = body.scopeType === 'thread' ? 'thread' : 'global';
    const scopeId = scopeType === 'thread'
      ? requiredId(session.threadId && body.scopeId === session.threadId ? body.scopeId : '', 'current thread scope')
      : '*';
    const policy = this.policyStore.setPolicy({
      guildId: session.guildId,
      scopeType,
      scopeId,
      settings: body.settings,
    }, session.userId);
    return { ok: true, policy };
  }

  async invoke(sessionId, method, body = {}) {
    const rpcMethod = assertRpcMethod(method);
    const session = this.touch(sessionId);
    if (rpcMethod === 'admin.bootstrap') return this.bootstrap(session);
    if (rpcMethod === 'providers.discover') return this.providerDiscover(session, body);
    if (rpcMethod === 'providers.create') return this.providerCreate(session, body);
    if (rpcMethod.startsWith('providers.')) return this.providerAction(rpcMethod, session, body);
    if (rpcMethod === 'bindings.save') return this.saveBinding(session, body);
    if (rpcMethod === 'policy.save') return this.savePolicy(session, body);
    throw new Error(`Unsupported admin RPC method: ${rpcMethod}`);
  }

  close() {
    this.sessions.clear();
  }
}
