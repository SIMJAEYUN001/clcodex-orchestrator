import { performance } from 'node:perf_hooks';

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,99}$/;
const AUTH_STYLES = new Set(['api-key-helper', 'x-api-key', 'bearer']);

function name(value) {
  const result = String(value || '').trim();
  if (result.length < 2 || result.length > 64) throw new Error('Profile name must be 2-64 characters');
  return result;
}

function authStyle(value, harness) {
  const result = String(value || (harness === 'claude' ? 'api-key-helper' : 'bearer')).trim().toLowerCase();
  if (!AUTH_STYLES.has(result)) throw new Error('Auth style must be api-key-helper, x-api-key, or bearer');
  if (harness === 'codex' && result === 'api-key-helper') throw new Error('Codex does not use api-key-helper');
  return result;
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
      displayName: typeof item === 'object' && item?.display_name ? String(item.display_name) : raw,
      metadata: typeof item === 'object' ? { ownedBy: item.owned_by || item.provider || undefined } : {},
    });
  }
  if (!models.length) throw new Error('Provider returned no valid model IDs');
  return models;
}

export class ProviderService {
  constructor({ store, vault, networkPolicy, timeoutMs = 12_000 }) {
    this.store = store;
    this.vault = vault;
    this.networkPolicy = networkPolicy;
    this.timeoutMs = timeoutMs;
  }

  async create(input, actorId) {
    if (!['claude', 'codex'].includes(input.harness)) throw new Error('Harness must be claude or codex');
    const url = await this.networkPolicy.assertAllowed(input.baseUrl);
    const profile = this.store.createProfile({
      guildId: input.guildId,
      name: name(input.name),
      harness: input.harness,
      baseUrl: url.toString().replace(/\/$/, ''),
      modelsPath: this.networkPolicy.modelsPath(input.modelsPath),
      authStyle: authStyle(input.authStyle, input.harness),
    }, actorId);
    const models = normalizeModels(input.models || []);
    if (models.length) this.store.replaceModels(profile.id, models, actorId, 'create');
    return this.describe(profile.id);
  }

  async update(providerId, patch, actorId) {
    const current = this.store.requireProfile(providerId);
    const url = patch.baseUrl ? await this.networkPolicy.assertAllowed(patch.baseUrl) : new URL(current.baseUrl);
    return this.store.updateProfile(providerId, {
      name: patch.name ? name(patch.name) : current.name,
      baseUrl: url.toString().replace(/\/$/, ''),
      modelsPath: patch.modelsPath ? this.networkPolicy.modelsPath(patch.modelsPath) : current.modelsPath,
      authStyle: patch.authStyle ? authStyle(patch.authStyle, current.harness) : current.authStyle,
      enabled: patch.enabled,
    }, actorId);
  }

  models(providerId, values, actorId) {
    return this.store.replaceModels(providerId, normalizeModels(values), actorId, 'manual');
  }

  encryptedSecret(providerId, value, actorId) {
    this.store.setSecret(providerId, this.vault.encrypted(providerId, value), actorId);
  }

  envSecret(providerId, value, actorId) {
    this.store.setSecret(providerId, this.vault.envReference(value), actorId);
  }

  fileSecret(providerId, value, actorId) {
    this.store.setSecret(providerId, this.vault.fileReference(value), actorId);
  }

  credential(providerId) {
    return this.vault.resolve(providerId, this.store.getSecret(providerId));
  }

  headers(profile, credential) {
    if (profile.authStyle === 'bearer') return { accept: 'application/json', authorization: `Bearer ${credential}` };
    return { accept: 'application/json', 'x-api-key': credential, 'anthropic-version': '2023-06-01' };
  }

  async remoteModels(providerId) {
    const profile = this.store.requireProfile(providerId);
    if (!profile.enabled) throw new Error('Provider is disabled');
    const base = await this.networkPolicy.assertAllowed(profile.baseUrl);
    const endpoint = new URL(this.networkPolicy.modelsPath(profile.modelsPath), base);
    const started = performance.now();
    let response;
    try {
      response = await fetch(endpoint, {
        method: 'GET',
        headers: this.headers(profile, this.credential(providerId)),
        redirect: 'error',
        cache: 'no-store',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new Error(`Provider request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
    const payload = await jsonLimited(response);
    return {
      models: extractModels(payload),
      status: response.status,
      latencyMs: Math.round(performance.now() - started),
    };
  }

  async sync(providerId, actorId) {
    const result = await this.remoteModels(providerId);
    return { ...result, models: this.store.replaceModels(providerId, result.models, actorId, 'remote') };
  }

  async test(providerId) {
    const result = await this.remoteModels(providerId);
    return { status: result.status, latencyMs: result.latencyMs, modelCount: result.models.length };
  }

  bind(input, actorId) {
    return this.store.setBinding({ ...input, modelKey: modelId(input.modelKey) }, actorId);
  }

  describe(providerId) {
    const profile = this.store.requireProfile(providerId);
    const secret = this.store.getSecret(providerId);
    return {
      ...profile,
      models: this.store.listModels(providerId),
      secret: secret ? { configured: true, mode: secret.mode, hint: secret.hint } : { configured: false, mode: null, hint: '미설정' },
    };
  }

  list(guildId, enabledOnly = false) {
    return this.store.listProfiles(guildId, enabledOnly).map((item) => this.describe(item.id));
  }
}

export const __test = { normalizeModels, extractModels, modelId, authStyle };
