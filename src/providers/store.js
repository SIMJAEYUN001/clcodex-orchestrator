import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROLES } from '../roles.js';

export { ROLES } from '../roles.js';
const ROLE_SET = new Set(ROLES);
const HARNESS_SET = new Set(['claude', 'codex']);
const AUTH_SET = new Set(['api-key-helper', 'x-api-key', 'bearer']);
const SECRET_SET = new Set(['encrypted', 'env', 'file']);

function now() {
  return new Date().toISOString();
}

function assertOneOf(value, values, label) {
  if (!values.has(value)) throw new Error(`Invalid ${label}: ${value}`);
}

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function profile(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    name: row.name,
    harness: row.harness,
    protocol: row.protocol,
    baseUrl: row.base_url,
    modelsPath: row.models_path,
    authStyle: row.auth_style,
    enabled: row.enabled === 1,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function model(row) {
  return {
    id: row.id,
    providerId: row.provider_id,
    modelKey: row.model_key,
    displayName: row.display_name,
    enabled: row.enabled === 1,
    metadata: parseJson(row.metadata_json),
  };
}

function binding(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    role: row.role,
    providerId: row.provider_id,
    modelKey: row.model_key,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function workEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    threadId: row.thread_id,
    goalId: row.goal_id,
    taskId: row.task_id,
    role: row.role,
    eventType: row.event_type,
    summary: row.summary,
    providerId: row.provider_id,
    modelKey: row.model_key,
    botUserId: row.bot_user_id,
    messageId: row.message_id,
    metadata: parseJson(row.metadata_json),
    createdAt: row.created_at,
  };
}

export class ProviderStore {
  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS provider_profiles (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        harness TEXT NOT NULL CHECK(harness IN ('claude','codex')),
        protocol TEXT NOT NULL CHECK(protocol IN ('anthropic','openai')),
        base_url TEXT NOT NULL,
        models_path TEXT NOT NULL DEFAULT '/v1/models',
        auth_style TEXT NOT NULL CHECK(auth_style IN ('api-key-helper','x-api-key','bearer')),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(guild_id,name)
      );
      CREATE TABLE IF NOT EXISTS provider_models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        display_name TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id,model_key)
      );
      CREATE TABLE IF NOT EXISTS provider_secrets (
        provider_id TEXT PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
        mode TEXT NOT NULL CHECK(mode IN ('encrypted','env','file')),
        ciphertext TEXT,
        nonce TEXT,
        auth_tag TEXT,
        reference_value TEXT,
        hint TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_model_bindings (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('global','thread')),
        scope_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator','backend','frontend','reviewer')),
        provider_id TEXT NOT NULL REFERENCES provider_profiles(id) ON DELETE CASCADE,
        model_key TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(guild_id,scope_type,scope_id,role)
      );
      CREATE TABLE IF NOT EXISTS provider_audit (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS role_work_events (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        goal_id TEXT,
        task_id TEXT,
        role TEXT NOT NULL CHECK(role IN ('orchestrator','backend','frontend','reviewer')),
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        provider_id TEXT,
        model_key TEXT,
        bot_user_id TEXT,
        message_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_profiles_guild ON provider_profiles(guild_id,enabled,name);
      CREATE INDEX IF NOT EXISTS idx_models_provider ON provider_models(provider_id,enabled,model_key);
      CREATE INDEX IF NOT EXISTS idx_bindings_lookup ON role_model_bindings(guild_id,scope_type,scope_id,role);
      CREATE INDEX IF NOT EXISTS idx_audit_guild ON provider_audit(guild_id,created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_role_work_lookup ON role_work_events(guild_id,thread_id,role,created_at DESC);
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  audit(guildId, actorId, action, targetType, targetId, details = {}) {
    this.db.prepare(`
      INSERT INTO provider_audit(id,guild_id,actor_id,action,target_type,target_id,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).run(randomUUID(), guildId, actorId, action, targetType, targetId, JSON.stringify(details), now());
  }

  createProfile(input, actorId) {
    assertOneOf(input.harness, HARNESS_SET, 'harness');
    assertOneOf(input.authStyle, AUTH_SET, 'auth style');
    const id = randomUUID();
    const timestamp = now();
    const protocol = input.harness === 'claude' ? 'anthropic' : 'openai';
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO provider_profiles(
          id,guild_id,name,harness,protocol,base_url,models_path,auth_style,enabled,revision,
          created_by,updated_by,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,1,1,?,?,?,?)
      `).run(
        id, input.guildId, input.name, input.harness, protocol, input.baseUrl,
        input.modelsPath || '/v1/models', input.authStyle, actorId, actorId, timestamp, timestamp,
      );
      this.audit(input.guildId, actorId, 'provider.create', 'provider', id, {
        name: input.name,
        harness: input.harness,
        protocol,
        baseUrl: input.baseUrl,
        modelsPath: input.modelsPath || '/v1/models',
        authStyle: input.authStyle,
      });
    });
    return this.requireProfile(id);
  }

  updateProfile(providerId, patch, actorId) {
    const current = this.requireProfile(providerId);
    const next = {
      name: patch.name ?? current.name,
      baseUrl: patch.baseUrl ?? current.baseUrl,
      modelsPath: patch.modelsPath ?? current.modelsPath,
      authStyle: patch.authStyle ?? current.authStyle,
      enabled: patch.enabled ?? current.enabled,
    };
    assertOneOf(next.authStyle, AUTH_SET, 'auth style');
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(`
        UPDATE provider_profiles SET name=?,base_url=?,models_path=?,auth_style=?,enabled=?,
          revision=revision+1,updated_by=?,updated_at=? WHERE id=?
      `).run(next.name, next.baseUrl, next.modelsPath, next.authStyle, next.enabled ? 1 : 0, actorId, timestamp, providerId);
      this.audit(current.guildId, actorId, 'provider.update', 'provider', providerId, { before: current, after: next });
    });
    return this.requireProfile(providerId);
  }

  deleteProfile(providerId, actorId) {
    const current = this.requireProfile(providerId);
    this.transaction(() => {
      this.audit(current.guildId, actorId, 'provider.delete', 'provider', providerId, { name: current.name });
      this.db.prepare('DELETE FROM provider_profiles WHERE id=?').run(providerId);
    });
  }

  getProfile(providerId) {
    return profile(this.db.prepare('SELECT * FROM provider_profiles WHERE id=?').get(providerId));
  }

  requireProfile(providerId) {
    const value = this.getProfile(providerId);
    if (!value) throw new Error('Provider profile not found');
    return value;
  }

  listProfiles(guildId, enabledOnly = false) {
    const sql = enabledOnly
      ? 'SELECT * FROM provider_profiles WHERE guild_id=? AND enabled=1 ORDER BY name COLLATE NOCASE'
      : 'SELECT * FROM provider_profiles WHERE guild_id=? ORDER BY enabled DESC,name COLLATE NOCASE';
    return this.db.prepare(sql).all(guildId).map(profile);
  }

  replaceModels(providerId, values, actorId, source = 'manual') {
    const provider = this.requireProfile(providerId);
    const models = [];
    const seen = new Set();
    for (const value of values) {
      const modelKey = String(value.modelKey || value.id || value).trim();
      if (!modelKey || seen.has(modelKey)) continue;
      seen.add(modelKey);
      models.push({
        modelKey,
        displayName: String(value.displayName || modelKey).trim(),
        metadata: value.metadata && typeof value.metadata === 'object' ? value.metadata : {},
      });
    }
    if (!models.length) throw new Error('At least one model is required');
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare('DELETE FROM provider_models WHERE provider_id=?').run(providerId);
      const insert = this.db.prepare(`
        INSERT INTO provider_models(id,provider_id,model_key,display_name,enabled,metadata_json,created_at,updated_at)
        VALUES(?,?,?,?,1,?,?,?)
      `);
      for (const item of models) {
        insert.run(randomUUID(), providerId, item.modelKey, item.displayName, JSON.stringify(item.metadata), timestamp, timestamp);
      }
      const placeholders = models.map(() => '?').join(',');
      this.db.prepare(`DELETE FROM role_model_bindings WHERE provider_id=? AND model_key NOT IN (${placeholders})`)
        .run(providerId, ...models.map((item) => item.modelKey));
      this.db.prepare('UPDATE provider_profiles SET revision=revision+1,updated_by=?,updated_at=? WHERE id=?')
        .run(actorId, timestamp, providerId);
      this.audit(provider.guildId, actorId, 'models.replace', 'provider', providerId, {
        source,
        models: models.map((item) => item.modelKey),
      });
    });
    return this.listModels(providerId);
  }

  listModels(providerId) {
    return this.db.prepare('SELECT * FROM provider_models WHERE provider_id=? AND enabled=1 ORDER BY display_name COLLATE NOCASE')
      .all(providerId).map(model);
  }

  hasModel(providerId, modelKey) {
    return Boolean(this.db.prepare('SELECT 1 AS ok FROM provider_models WHERE provider_id=? AND model_key=? AND enabled=1')
      .get(providerId, modelKey)?.ok);
  }

  setSecret(providerId, record, actorId) {
    assertOneOf(record.mode, SECRET_SET, 'secret mode');
    const provider = this.requireProfile(providerId);
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO provider_secrets(provider_id,mode,ciphertext,nonce,auth_tag,reference_value,hint,updated_by,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_id) DO UPDATE SET
          mode=excluded.mode,ciphertext=excluded.ciphertext,nonce=excluded.nonce,
          auth_tag=excluded.auth_tag,reference_value=excluded.reference_value,hint=excluded.hint,
          updated_by=excluded.updated_by,updated_at=excluded.updated_at
      `).run(
        providerId, record.mode, record.ciphertext || null, record.nonce || null,
        record.tag || null, record.reference || null, record.hint, actorId, timestamp,
      );
      this.db.prepare('UPDATE provider_profiles SET revision=revision+1,updated_by=?,updated_at=? WHERE id=?')
        .run(actorId, timestamp, providerId);
      this.audit(provider.guildId, actorId, 'secret.set', 'provider', providerId, { mode: record.mode, hint: record.hint });
    });
  }

  getSecret(providerId) {
    const row = this.db.prepare('SELECT * FROM provider_secrets WHERE provider_id=?').get(providerId);
    if (!row) return null;
    return {
      providerId: row.provider_id,
      mode: row.mode,
      ciphertext: row.ciphertext,
      nonce: row.nonce,
      tag: row.auth_tag,
      reference: row.reference_value,
      hint: row.hint,
      updatedAt: row.updated_at,
    };
  }

  clearSecret(providerId, actorId) {
    const provider = this.requireProfile(providerId);
    this.transaction(() => {
      this.db.prepare('DELETE FROM provider_secrets WHERE provider_id=?').run(providerId);
      this.db.prepare('UPDATE provider_profiles SET revision=revision+1,updated_by=?,updated_at=? WHERE id=?')
        .run(actorId, now(), providerId);
      this.audit(provider.guildId, actorId, 'secret.clear', 'provider', providerId);
    });
  }

  setBinding(input, actorId) {
    if (!ROLE_SET.has(input.role)) throw new Error(`Invalid role: ${input.role}`);
    if (!['global', 'thread'].includes(input.scopeType)) throw new Error('Invalid binding scope');
    const provider = this.requireProfile(input.providerId);
    if (provider.guildId !== input.guildId || !provider.enabled) throw new Error('Provider is unavailable for this server');
    if (!this.hasModel(provider.id, input.modelKey)) throw new Error('Selected model is unavailable');
    const timestamp = now();
    const existing = this.db.prepare(`
      SELECT id FROM role_model_bindings WHERE guild_id=? AND scope_type=? AND scope_id=? AND role=?
    `).get(input.guildId, input.scopeType, input.scopeId, input.role);
    const id = existing?.id || randomUUID();
    this.transaction(() => {
      this.db.prepare(`
        INSERT INTO role_model_bindings(id,guild_id,scope_type,scope_id,role,provider_id,model_key,updated_by,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(guild_id,scope_type,scope_id,role) DO UPDATE SET
          provider_id=excluded.provider_id,model_key=excluded.model_key,
          updated_by=excluded.updated_by,updated_at=excluded.updated_at
      `).run(id, input.guildId, input.scopeType, input.scopeId, input.role, provider.id, input.modelKey, actorId, timestamp);
      this.audit(input.guildId, actorId, 'role-model.set', 'binding', id, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        role: input.role,
        providerId: provider.id,
        modelKey: input.modelKey,
      });
    });
    return this.getBinding(input.guildId, input.scopeType, input.scopeId, input.role);
  }

  clearBinding(input, actorId) {
    if (!ROLE_SET.has(input.role)) throw new Error(`Invalid role: ${input.role}`);
    const current = this.getBinding(input.guildId, input.scopeType, input.scopeId, input.role);
    if (!current) return false;
    this.transaction(() => {
      this.db.prepare('DELETE FROM role_model_bindings WHERE id=?').run(current.id);
      this.audit(input.guildId, actorId, 'role-model.clear', 'binding', current.id, {
        scopeType: input.scopeType,
        scopeId: input.scopeId,
        role: input.role,
      });
    });
    return true;
  }

  getBinding(guildId, scopeType, scopeId, role) {
    return binding(this.db.prepare(`
      SELECT * FROM role_model_bindings WHERE guild_id=? AND scope_type=? AND scope_id=? AND role=?
    `).get(guildId, scopeType, scopeId, role));
  }

  listBindings(guildId, scopeType, scopeId) {
    return this.db.prepare(`
      SELECT * FROM role_model_bindings WHERE guild_id=? AND scope_type=? AND scope_id=? ORDER BY role
    `).all(guildId, scopeType, scopeId).map(binding);
  }

  resolveBinding(guildId, threadId, role) {
    if (!ROLE_SET.has(role)) throw new Error(`Invalid role: ${role}`);
    if (threadId) {
      const thread = this.getBinding(guildId, 'thread', threadId, role);
      if (thread) return thread;
    }
    return this.getBinding(guildId, 'global', '*', role);
  }

  listAudit(guildId, limit = 20) {
    const count = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.db.prepare('SELECT * FROM provider_audit WHERE guild_id=? ORDER BY created_at DESC LIMIT ?')
      .all(guildId, count)
      .map((row) => ({
        id: row.id,
        actorId: row.actor_id,
        action: row.action,
        targetId: row.target_id,
        details: parseJson(row.details_json),
        createdAt: row.created_at,
      }));
  }

  appendWorkEvent(input) {
    if (!ROLE_SET.has(input.role)) throw new Error(`Invalid role: ${input.role}`);
    if (!input.guildId || !input.threadId || !input.eventType) {
      throw new Error('Work events require guildId, threadId, and eventType');
    }
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO role_work_events(
        id,guild_id,thread_id,goal_id,task_id,role,event_type,summary,
        provider_id,model_key,bot_user_id,message_id,metadata_json,created_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      id,
      input.guildId,
      input.threadId,
      input.goalId || null,
      input.taskId || null,
      input.role,
      input.eventType,
      String(input.summary || ''),
      input.providerId || null,
      input.modelKey || null,
      input.botUserId || null,
      input.messageId || null,
      JSON.stringify(input.metadata || {}),
      now(),
    );
    return workEvent(this.db.prepare('SELECT * FROM role_work_events WHERE id=?').get(id));
  }

  listWorkEvents({ guildId, threadId, role, limit = 10 }) {
    if (!ROLE_SET.has(role)) throw new Error(`Invalid role: ${role}`);
    const count = Math.max(1, Math.min(100, Number(limit) || 10));
    return this.db.prepare(`
      SELECT * FROM role_work_events
      WHERE guild_id=? AND thread_id=? AND role=?
      ORDER BY created_at DESC,id DESC LIMIT ?
    `).all(guildId, threadId, role, count).map(workEvent);
  }

  close() {
    this.db.close();
  }
}
