import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROLES } from '../roles.js';

const ROLE_SET = new Set(ROLES);
const SCOPE_SET = new Set(['global', 'thread']);

export const CODEX_APPROVAL_POLICIES = Object.freeze(['untrusted', 'on-request', 'never']);
export const CODEX_SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);
export const CODEX_REASONING_EFFORTS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
export const CODEX_VERBOSITIES = Object.freeze(['low', 'medium', 'high']);
export const CODEX_WEB_SEARCH_MODES = Object.freeze(['disabled', 'cached', 'live']);
export const CLAUDE_PERMISSION_MODES = Object.freeze(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);
export const CLAUDE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const SPEC_WORKFLOWS = Object.freeze(['requirements-first', 'design-first', 'quick-plan']);

const DEFAULT_CLAUDE = Object.freeze({
  permissionMode: 'default',
  effort: 'high',
  allowedTools: [],
  disallowedTools: [],
  fallbackModel: '',
});

const DEFAULT_CODEX = Object.freeze({
  approvalPolicy: 'on-request',
  sandboxMode: 'workspace-write',
  reasoningEffort: 'high',
  verbosity: 'medium',
  webSearch: 'disabled',
});

export const DEFAULT_ROLE_SETTINGS = Object.freeze({
  orchestrator: Object.freeze({
    claude: Object.freeze({ ...DEFAULT_CLAUDE, permissionMode: 'plan' }),
    codex: Object.freeze({ ...DEFAULT_CODEX, sandboxMode: 'read-only' }),
  }),
  backend: Object.freeze({
    claude: Object.freeze({ ...DEFAULT_CLAUDE, permissionMode: 'acceptEdits' }),
    codex: Object.freeze({ ...DEFAULT_CODEX }),
  }),
  frontend: Object.freeze({
    claude: Object.freeze({ ...DEFAULT_CLAUDE, permissionMode: 'acceptEdits' }),
    codex: Object.freeze({ ...DEFAULT_CODEX }),
  }),
  reviewer: Object.freeze({
    claude: Object.freeze({
      ...DEFAULT_CLAUDE,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Grep', 'Glob'],
      disallowedTools: ['Edit', 'Write', 'NotebookEdit'],
    }),
    codex: Object.freeze({ ...DEFAULT_CODEX, approvalPolicy: 'never', sandboxMode: 'read-only' }),
  }),
});

export const ORCHESTRATION_PRESETS = Object.freeze({
  'strict-spec': Object.freeze({
    preset: 'strict-spec',
    workflow: 'requirements-first',
    autoRun: false,
    maxParallelAgents: 2,
    approvalGates: Object.freeze({ requirements: true, design: true, tasks: true }),
    reviewPolicy: 'required',
    disputePolicy: 'automatic',
    mergeStrategy: 'serial-cherry-pick',
    stopOnFailure: true,
    autoResume: true,
  }),
  balanced: Object.freeze({
    preset: 'balanced',
    workflow: 'requirements-first',
    autoRun: false,
    maxParallelAgents: 3,
    approvalGates: Object.freeze({ requirements: true, design: true, tasks: true }),
    reviewPolicy: 'required',
    disputePolicy: 'automatic',
    mergeStrategy: 'serial-cherry-pick',
    stopOnFailure: true,
    autoResume: true,
  }),
  rapid: Object.freeze({
    preset: 'rapid',
    workflow: 'quick-plan',
    autoRun: true,
    maxParallelAgents: 4,
    approvalGates: Object.freeze({ requirements: false, design: false, tasks: true }),
    reviewPolicy: 'required',
    disputePolicy: 'automatic',
    mergeStrategy: 'serial-cherry-pick',
    stopOnFailure: true,
    autoResume: true,
  }),
  'review-heavy': Object.freeze({
    preset: 'review-heavy',
    workflow: 'design-first',
    autoRun: false,
    maxParallelAgents: 2,
    approvalGates: Object.freeze({ requirements: true, design: true, tasks: true }),
    reviewPolicy: 'required',
    disputePolicy: 'automatic',
    mergeStrategy: 'serial-cherry-pick',
    stopOnFailure: true,
    autoResume: true,
  }),
});

function now() { return new Date().toISOString(); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function parse(value, fallback) { try { return JSON.parse(value); } catch { return clone(fallback); } }
function assertEnum(value, values, label) {
  if (!values.includes(value)) throw new Error(`Invalid ${label}: ${value}`);
  return value;
}
function stringArray(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = [];
  const seen = new Set();
  for (const raw of value) {
    const item = String(raw || '').trim();
    if (!item || item.length > 160) throw new Error(`Invalid ${label} item`);
    if (!seen.has(item)) { seen.add(item); result.push(item); }
  }
  return result;
}
function assertScope(scopeType, scopeId) {
  if (!SCOPE_SET.has(scopeType)) throw new Error(`Invalid scope: ${scopeType}`);
  if (scopeType === 'global' && scopeId !== '*') throw new Error('Global scope ID must be *');
  if (scopeType === 'thread' && !String(scopeId || '').trim()) throw new Error('Thread scope requires a thread ID');
}
function deepMerge(base, patch) {
  const output = clone(base);
  for (const [key, value] of Object.entries(patch || {})) {
    if (value && typeof value === 'object' && !Array.isArray(value) && output[key] && typeof output[key] === 'object' && !Array.isArray(output[key])) {
      output[key] = deepMerge(output[key], value);
    } else {
      output[key] = clone(value);
    }
  }
  return output;
}

export function validateRoleSettings(role, input = {}) {
  if (!ROLE_SET.has(role)) throw new Error(`Invalid role: ${role}`);
  const defaults = DEFAULT_ROLE_SETTINGS[role];
  const merged = deepMerge(defaults, input);
  const claude = merged.claude || {};
  const codex = merged.codex || {};
  const normalized = {
    claude: {
      permissionMode: assertEnum(String(claude.permissionMode), CLAUDE_PERMISSION_MODES, 'Claude permission mode'),
      effort: assertEnum(String(claude.effort), CLAUDE_EFFORTS, 'Claude effort'),
      allowedTools: stringArray(claude.allowedTools, 'Claude allowed tools'),
      disallowedTools: stringArray(claude.disallowedTools, 'Claude disallowed tools'),
      fallbackModel: String(claude.fallbackModel || '').trim().slice(0, 100),
    },
    codex: {
      approvalPolicy: assertEnum(String(codex.approvalPolicy), CODEX_APPROVAL_POLICIES, 'Codex approval policy'),
      sandboxMode: assertEnum(String(codex.sandboxMode), CODEX_SANDBOX_MODES, 'Codex sandbox mode'),
      reasoningEffort: assertEnum(String(codex.reasoningEffort), CODEX_REASONING_EFFORTS, 'Codex reasoning effort'),
      verbosity: assertEnum(String(codex.verbosity), CODEX_VERBOSITIES, 'Codex verbosity'),
      webSearch: assertEnum(String(codex.webSearch), CODEX_WEB_SEARCH_MODES, 'Codex web search mode'),
    },
  };
  if (role === 'reviewer') {
    normalized.claude.permissionMode = 'plan';
    normalized.claude.disallowedTools = [...new Set([...normalized.claude.disallowedTools, 'Edit', 'Write', 'NotebookEdit'])];
    normalized.codex.approvalPolicy = 'never';
    normalized.codex.sandboxMode = 'read-only';
  }
  if (role === 'orchestrator') {
    normalized.codex.sandboxMode = 'read-only';
    if (normalized.claude.permissionMode === 'bypassPermissions') normalized.claude.permissionMode = 'plan';
  }
  return normalized;
}

function normalizeRolePatch(role, input = {}) {
  const validated = validateRoleSettings(role, input);
  const patch = {};
  if (input.claude && typeof input.claude === 'object' && !Array.isArray(input.claude)) {
    patch.claude = {};
    for (const key of ['permissionMode', 'effort', 'allowedTools', 'disallowedTools', 'fallbackModel']) {
      if (Object.hasOwn(input.claude, key)) patch.claude[key] = clone(validated.claude[key]);
    }
    if (!Object.keys(patch.claude).length) delete patch.claude;
  }
  if (input.codex && typeof input.codex === 'object' && !Array.isArray(input.codex)) {
    patch.codex = {};
    for (const key of ['approvalPolicy', 'sandboxMode', 'reasoningEffort', 'verbosity', 'webSearch']) {
      if (Object.hasOwn(input.codex, key)) patch.codex[key] = clone(validated.codex[key]);
    }
    if (!Object.keys(patch.codex).length) delete patch.codex;
  }
  return patch;
}

export function validateOrchestrationPolicy(input = {}) {
  const presetName = String(input.preset || 'balanced');
  const base = ORCHESTRATION_PRESETS[presetName];
  if (!base) throw new Error(`Invalid orchestration preset: ${presetName}`);
  const merged = deepMerge(base, input);
  const maxParallelAgents = Number(merged.maxParallelAgents);
  if (!Number.isInteger(maxParallelAgents) || maxParallelAgents < 1 || maxParallelAgents > 8) {
    throw new Error('maxParallelAgents must be an integer from 1 to 8');
  }
  return {
    preset: presetName,
    workflow: assertEnum(String(merged.workflow), SPEC_WORKFLOWS, 'spec workflow'),
    autoRun: Boolean(merged.autoRun),
    maxParallelAgents,
    approvalGates: {
      requirements: Boolean(merged.approvalGates?.requirements),
      design: Boolean(merged.approvalGates?.design),
      tasks: true,
    },
    reviewPolicy: 'required',
    disputePolicy: 'automatic',
    mergeStrategy: 'serial-cherry-pick',
    stopOnFailure: merged.stopOnFailure !== false,
    autoResume: merged.autoResume !== false,
  };
}

function roleRow(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    role: row.role,
    settings: parse(row.settings_json, DEFAULT_ROLE_SETTINGS[row.role]),
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function policyRow(row) {
  if (!row) return null;
  return {
    guildId: row.guild_id,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    settings: parse(row.settings_json, ORCHESTRATION_PRESETS.balanced),
    revision: row.revision,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

export class OrchestrationPolicyStore {
  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runtime_role_settings (
        guild_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('global','thread')),
        scope_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('orchestrator','backend','frontend','reviewer')),
        settings_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(guild_id,scope_type,scope_id,role)
      );
      CREATE TABLE IF NOT EXISTS orchestration_policies (
        guild_id TEXT NOT NULL,
        scope_type TEXT NOT NULL CHECK(scope_type IN ('global','thread')),
        scope_id TEXT NOT NULL,
        settings_json TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(guild_id,scope_type,scope_id)
      );
      CREATE TABLE IF NOT EXISTS orchestration_audit (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_orchestration_audit ON orchestration_audit(guild_id,created_at DESC);
    `);
  }

  audit(guildId, actorId, action, target, details = {}) {
    this.db.prepare('INSERT INTO orchestration_audit(id,guild_id,actor_id,action,target,details_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(randomUUID(), guildId, actorId || 'system', action, target, JSON.stringify(details), now());
  }

  getRoleSettings(guildId, scopeType, scopeId, role) {
    return roleRow(this.db.prepare('SELECT * FROM runtime_role_settings WHERE guild_id=? AND scope_type=? AND scope_id=? AND role=?')
      .get(guildId, scopeType, scopeId, role));
  }

  setRoleSettings({ guildId, scopeType, scopeId, role, settings }, actorId) {
    assertScope(scopeType, scopeId);
    const normalized = normalizeRolePatch(role, settings);
    const timestamp = now();
    this.db.prepare(`INSERT INTO runtime_role_settings(guild_id,scope_type,scope_id,role,settings_json,revision,updated_by,updated_at)
      VALUES(?,?,?,?,?,1,?,?) ON CONFLICT(guild_id,scope_type,scope_id,role) DO UPDATE SET
      settings_json=excluded.settings_json,revision=runtime_role_settings.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(guildId, scopeType, scopeId, role, JSON.stringify(normalized), actorId, timestamp);
    const result = this.getRoleSettings(guildId, scopeType, scopeId, role);
    this.audit(guildId, actorId, 'runtime-role-settings.set', `${scopeType}:${scopeId}:${role}`, { revision: result.revision, settings: normalized });
    return result;
  }

  clearRoleSettings({ guildId, scopeType, scopeId, role }, actorId) {
    assertScope(scopeType, scopeId);
    if (!ROLE_SET.has(role)) throw new Error(`Invalid role: ${role}`);
    this.db.prepare('DELETE FROM runtime_role_settings WHERE guild_id=? AND scope_type=? AND scope_id=? AND role=?')
      .run(guildId, scopeType, scopeId, role);
    this.audit(guildId, actorId, 'runtime-role-settings.clear', `${scopeType}:${scopeId}:${role}`, {});
  }

  resolveRoleSettings(guildId, threadId, role) {
    if (!ROLE_SET.has(role)) throw new Error(`Invalid role: ${role}`);
    const global = this.getRoleSettings(guildId, 'global', '*', role);
    const thread = threadId ? this.getRoleSettings(guildId, 'thread', threadId, role) : null;
    const settings = validateRoleSettings(role, deepMerge(deepMerge(DEFAULT_ROLE_SETTINGS[role], global?.settings || {}), thread?.settings || {}));
    return {
      settings,
      scopeType: thread ? 'thread' : global ? 'global' : 'default',
      revision: thread?.revision ?? global?.revision ?? 0,
      updatedAt: thread?.updatedAt ?? global?.updatedAt ?? null,
    };
  }

  getPolicy(guildId, scopeType, scopeId) {
    return policyRow(this.db.prepare('SELECT * FROM orchestration_policies WHERE guild_id=? AND scope_type=? AND scope_id=?')
      .get(guildId, scopeType, scopeId));
  }

  setPolicy({ guildId, scopeType, scopeId, settings }, actorId) {
    assertScope(scopeType, scopeId);
    const normalized = validateOrchestrationPolicy(settings);
    const timestamp = now();
    this.db.prepare(`INSERT INTO orchestration_policies(guild_id,scope_type,scope_id,settings_json,revision,updated_by,updated_at)
      VALUES(?,?,?,?,1,?,?) ON CONFLICT(guild_id,scope_type,scope_id) DO UPDATE SET
      settings_json=excluded.settings_json,revision=orchestration_policies.revision+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
      .run(guildId, scopeType, scopeId, JSON.stringify(normalized), actorId, timestamp);
    const result = this.getPolicy(guildId, scopeType, scopeId);
    this.audit(guildId, actorId, 'orchestration-policy.set', `${scopeType}:${scopeId}`, { revision: result.revision, settings: normalized });
    return result;
  }

  clearPolicy({ guildId, scopeType, scopeId }, actorId) {
    assertScope(scopeType, scopeId);
    this.db.prepare('DELETE FROM orchestration_policies WHERE guild_id=? AND scope_type=? AND scope_id=?')
      .run(guildId, scopeType, scopeId);
    this.audit(guildId, actorId, 'orchestration-policy.clear', `${scopeType}:${scopeId}`, {});
  }

  resolvePolicy(guildId, threadId) {
    const global = this.getPolicy(guildId, 'global', '*');
    const thread = threadId ? this.getPolicy(guildId, 'thread', threadId) : null;
    const base = global?.settings || ORCHESTRATION_PRESETS.balanced;
    const settings = validateOrchestrationPolicy(deepMerge(base, thread?.settings || {}));
    return {
      settings,
      scopeType: thread ? 'thread' : global ? 'global' : 'default',
      revision: thread?.revision ?? global?.revision ?? 0,
      updatedAt: thread?.updatedAt ?? global?.updatedAt ?? null,
    };
  }

  snapshot(guildId, threadId) {
    return {
      policy: this.resolvePolicy(guildId, threadId),
      roles: Object.fromEntries(ROLES.map((role) => [role, this.resolveRoleSettings(guildId, threadId, role)])),
      explicit: {
        globalPolicy: this.getPolicy(guildId, 'global', '*'),
        threadPolicy: threadId ? this.getPolicy(guildId, 'thread', threadId) : null,
        roleSettings: Object.fromEntries(ROLES.map((role) => [role, {
          global: this.getRoleSettings(guildId, 'global', '*', role),
          thread: threadId ? this.getRoleSettings(guildId, 'thread', threadId, role) : null,
        }])),
      },
    };
  }

  listAudit(guildId, limit = 50) {
    return this.db.prepare('SELECT * FROM orchestration_audit WHERE guild_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(guildId, Math.max(1, Math.min(Number(limit) || 50, 200)))
      .map((row) => ({
        id: row.id,
        guildId: row.guild_id,
        actorId: row.actor_id,
        action: row.action,
        target: row.target,
        details: parse(row.details_json, {}),
        createdAt: row.created_at,
      }));
  }

  close() { this.db.close(); }
}

export const __test = { deepMerge, assertScope, stringArray, normalizeRolePatch };
