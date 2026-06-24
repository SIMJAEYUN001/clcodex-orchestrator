import { performance } from 'node:perf_hooks';
import { ROLES } from '../roles.js';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/;
const AUTH_TYPES = new Set(['bearer', 'api-key', 'basic']);

function profileName(value) {
  const result = String(value || '').trim();
  if (result.length < 2 || result.length > 64) throw new Error('Profile name must be 2-64 characters');
  return result;
}

function authType(value) {
  const selected = String(value || 'bearer').trim().toLowerCase();
  const normalized = selected === 'x-api-key' || selected === 'api-key-helper' ? 'api-key' : selected;
  if (!AUTH_TYPES.has(normalized)) throw new Error('Authentication must be bearer, api-key, or basic');
  return normalized;
}

function authStyle(value, harness) {
  const selected = value || (harness === 'claude' ? 'api-key' : 'bearer');
  return authType(selected);
}

function authHeader(value) {
  const selected = String(value || 'x-api-key').trim();
  if (!HEADER_NAME.test(selected)) throw new Error('API key header name is invalid');
  if (['authorization', 'host', 'content-length', 'connection', 'transfer-encoding'].includes(selected.toLowerCase())) {
    throw new Error('Reserved header name cannot be used for API key authentication');
  }
  return selected;
}

function modelId(value) {
  const result = String(value || '').trim();
  if (!MODEL_ID.test(result)) throw new Error(`Invalid model ID: ${result || '(empty)'}`);
  return result;
}

function normalizeModels(values) {
  const source = Array.isArray(values) ? values : String(values || '').split(/[\n,]+/g);
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const key = modelId(typeof item === 'object' && item ? item.modelKey || item.id : item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      modelKey: key,
      displayName: typeof item === 'object' && item?.displayName ? String(item.displayName) : key,
      metadata: typeof item === 'object' && item?.metadata ? item.metadata : {},
    });
  }
  return result;
}

async function jsonLimited(response, maxBytes = 1_000_000) {
  const reader = response.body?.getReader();
  if (!reader) return JSON.parse(await response.text());
  const chunks = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error('Provider response exceeded the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function extractModels(payload) {
  const source = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : payload?.models;
  if (!Array.isArray(source)) throw new Error('Unsupported provider model-list response');
  const models = [];
  const seen = new Set();
  for (const item of source) {
    const raw = typeof item === 'string' ? item : item?.id || item?.name || item?.model;
    if (typeof raw !== 'string' || !MODEL_ID.test(raw) || seen.has(raw)) continue;
    seen.add(raw);
    models.push({
      modelKey: raw,
      displayName: typeof item === 'object' && (item?.display_name || item?.displayName) ? String(item.display_name || item.displayName) : raw,
      metadata: typeof item === 'object' ? { ownedBy: item.owned_by || item.provider || undefined } : {},
    });
  }
  if (!models.length) throw new Error('Provider returned no valid model IDs');
  return models;
}

function credentialHeaders(profile, credential) {
  const headers = { accept: 'application/json' };
  if (profile.authType === 'bearer') headers.authorization = `Bearer ${credential}`;
  else if (profile.authType === 'api-key') headers[authHeader(profile.authHeader)] = credential;
  else if (profile.authType === 'basic') {
    const username = String(profile.authUsername || '');
    if (!username) throw new Error('Basic authentication username is missing');
    headers.authorization = `Basic ${Buffer.from(`${username}:${credential}`, 'utf8').toString('base64')}`;
  } else throw new Error(`Unsupported provider authentication: ${profile.authType}`);
  if (profile.protocol === 'anthropic') headers['anthropic-version'] = '2023-06-01';
  return headers;
}

export class ProviderService {
  constructor({ store, vault, networkPolicy, timeoutMs = 12_000 }) {
    this.store = store;
    this.vault = vault;
    this.networkPolicy = networkPolicy;
    this.timeoutMs = timeoutMs;
  }

  normalizeProfileInput(input) {
    if (!['claude', 'codex'].includes(input.harness)) throw new Error('Harness must be claude or codex');
    const selectedAuth = authType(input.authType || input.authStyle);
    const username = selectedAuth === 'basic' ? String(input.authUsername || '').trim() : null;
    if (selectedAuth === 'basic' && !username) throw new Error('Basic authentication requires a username');
    return {
      guildId: input.guildId,
      name: profileName(input.name),
      harness: input.harness,
      baseUrl: input.baseUrl,
      modelsPath: this.networkPolicy.modelsPath(input.modelsPath || '/v1/models'),
      authType: selectedAuth,
      authHeader: selectedAuth === 'api-key' ? authHeader(input.authHeader) : null,
      authUsername: username,
      protocol: input.harness === 'claude' ? 'anthropic' : 'openai',
    };
  }

  async create(input, actorId) {
    const normalized = this.normalizeProfileInput(input);
    const url = await this.networkPolicy.assertAllowed(normalized.baseUrl);
    const profile = this.store.createProfile({ ...normalized, baseUrl: url.toString().replace(/\/$/, '') }, actorId);
    const models = input.models ? normalizeModels(input.models) : [];
    if (models.length) this.store.replaceModels(profile.id, models, actorId, 'create');
    return this.describe(profile.id);
  }

  async createConfigured(input, actorId) {
    const normalized = this.normalizeProfileInput(input);
    const credential = String(input.credential || '').trim();
    if (!credential) throw new Error(input.authType === 'basic' ? 'Password is required' : 'API key/token is required');
    const url = await this.networkPolicy.assertAllowed(normalized.baseUrl);
    const profile = this.store.createProfile({ ...normalized, baseUrl: url.toString().replace(/\/$/, '') }, actorId);
    try {
      this.store.setSecret(profile.id, this.vault.encrypted(profile.id, credential), actorId);
      const discovered = await this.remoteModels(profile.id);
      const combined = [...discovered.models];
      if (input.initialModel) {
        const initial = modelId(input.initialModel);
        if (!combined.some((item) => item.modelKey === initial)) combined.unshift({ modelKey: initial, displayName: initial, metadata: { source: 'initial' } });
      }
      const requested = Array.isArray(input.selectedModels) && input.selectedModels.length
        ? new Set(input.selectedModels.map(modelId))
        : null;
      const selected = requested ? combined.filter((item) => requested.has(item.modelKey)) : combined;
      if (!selected.length) throw new Error('At least one discovered model must be selected');
      this.store.replaceModels(profile.id, selected, actorId, 'setup-wizard');
      const bindings = input.bindings && typeof input.bindings === 'object' ? input.bindings : {};
      for (const role of ROLES) {
        const model = bindings[role];
        if (!model) continue;
        const key = modelId(model);
        if (!selected.some((item) => item.modelKey === key)) throw new Error(`Binding for ${role} references an unselected model`);
        this.bind({
          guildId: normalized.guildId,
          scopeType: input.scopeType === 'thread' ? 'thread' : 'global',
          scopeId: input.scopeType === 'thread' ? String(input.scopeId || '') : '*',
          role,
          providerId: profile.id,
          modelKey: key,
        }, actorId);
      }
      return { provider: this.describe(profile.id), discovered, selected };
    } catch (error) {
      try { this.store.deleteProfile(profile.id, actorId); } catch { /* rollback best effort */ }
      throw error;
    }
  }

  async update(providerId, patch, actorId) {
    const current = this.store.requireProfile(providerId);
    const selectedAuth = patch.authType || patch.authStyle ? authType(patch.authType || patch.authStyle) : current.authType;
    const url = patch.baseUrl ? await this.networkPolicy.assertAllowed(patch.baseUrl) : new URL(current.baseUrl);
    return this.store.updateProfile(providerId, {
      name: patch.name ? profileName(patch.name) : current.name,
      baseUrl: url.toString().replace(/\/$/, ''),
      modelsPath: patch.modelsPath ? this.networkPolicy.modelsPath(patch.modelsPath) : current.modelsPath,
      authType: selectedAuth,
      authHeader: selectedAuth === 'api-key' ? authHeader(patch.authHeader || current.authHeader) : null,
      authUsername: selectedAuth === 'basic' ? String(patch.authUsername ?? current.authUsername ?? '').trim() : null,
      enabled: patch.enabled,
    }, actorId);
  }

  models(providerId, values, actorId) { return this.store.replaceModels(providerId, normalizeModels(values), actorId, 'manual'); }
  encryptedSecret(providerId, value, actorId) { this.store.setSecret(providerId, this.vault.encrypted(providerId, value), actorId); }
  envSecret(providerId, value, actorId) { this.store.setSecret(providerId, this.vault.envReference(value), actorId); }
  fileSecret(providerId, value, actorId) { this.store.setSecret(providerId, this.vault.fileReference(value), actorId); }
  credential(providerId) { return this.vault.resolve(providerId, this.store.getSecret(providerId)); }
  headers(profile, credential) { return credentialHeaders(profile, credential); }

  async fetchModels(profile, credential) {
    const base = await this.networkPolicy.assertAllowed(profile.baseUrl);
    const endpoint = new URL(this.networkPolicy.modelsPath(profile.modelsPath), base);
    const started = performance.now();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: credentialHeaders(profile, credential),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    const payload = await jsonLimited(response);
    return { models: extractModels(payload), status: response.status, latencyMs: Math.round(performance.now() - started) };
  }

  async discover(input) {
    const profile = this.normalizeProfileInput(input);
    const base = await this.networkPolicy.assertAllowed(profile.baseUrl);
    return this.fetchModels({ ...profile, baseUrl: base.toString().replace(/\/$/, '') }, String(input.credential || '').trim());
  }

  async remoteModels(providerId) {
    const profile = this.store.requireProfile(providerId);
    if (!profile.enabled) throw new Error('Provider is disabled');
    return this.fetchModels(profile, this.credential(providerId));
  }

  async sync(providerId, actorId) {
    const result = await this.remoteModels(providerId);
    return { ...result, models: this.store.replaceModels(providerId, result.models, actorId, 'remote') };
  }

  async test(providerId) {
    const result = await this.remoteModels(providerId);
    return { status: result.status, latencyMs: result.latencyMs, modelCount: result.models.length };
  }

  bind(input, actorId) { return this.store.setBinding({ ...input, modelKey: modelId(input.modelKey) }, actorId); }

  describe(providerId) {
    const profile = this.store.requireProfile(providerId);
    const configured = this.store.getSecret(providerId);
    return {
      ...profile,
      models: this.store.listModels(providerId),
      secret: configured ? { configured: true, mode: configured.mode, hint: configured.hint } : { configured: false, mode: null, hint: '미설정' },
    };
  }

  list(guildId, enabledOnly = false) { return this.store.listProfiles(guildId, enabledOnly).map((item) => this.describe(item.id)); }
}

export const __test = { normalizeModels, extractModels, modelId, authType, authStyle, authHeader, credentialHeaders };
