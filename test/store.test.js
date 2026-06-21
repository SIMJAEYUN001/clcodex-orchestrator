import assert from 'node:assert/strict';
import test from 'node:test';
import { ProviderStore } from '../src/providers/store.js';

function provider(store, name = 'proxy') {
  const created = store.createProfile({
    guildId: 'guild', name, harness: 'claude', baseUrl: 'http://127.0.0.1:8045',
    modelsPath: '/v1/models', authStyle: 'api-key-helper',
  }, 'admin');
  store.replaceModels(created.id, [{ modelKey: 'model-a' }, { modelKey: 'model-b' }], 'admin');
  return created;
}

test('thread role-model binding overrides and then falls back to the global binding', () => {
  const store = new ProviderStore(':memory:');
  const globalProvider = provider(store, 'global');
  const threadProvider = provider(store, 'thread');
  store.setBinding({ guildId: 'guild', scopeType: 'global', scopeId: '*', role: 'frontend', providerId: globalProvider.id, modelKey: 'model-a' }, 'admin');
  store.setBinding({ guildId: 'guild', scopeType: 'thread', scopeId: 'thread-1', role: 'frontend', providerId: threadProvider.id, modelKey: 'model-b' }, 'admin');
  assert.equal(store.resolveBinding('guild', 'thread-1', 'frontend').providerId, threadProvider.id);
  store.clearBinding({ guildId: 'guild', scopeType: 'thread', scopeId: 'thread-1', role: 'frontend' }, 'admin');
  assert.equal(store.resolveBinding('guild', 'thread-1', 'frontend').providerId, globalProvider.id);
  store.close();
});

test('all four role groups can have independent provider and model selections', () => {
  const store = new ProviderStore(':memory:');
  const selected = provider(store);
  const roles = ['orchestrator', 'backend', 'frontend', 'reviewer'];
  for (const [index, role] of roles.entries()) {
    store.setBinding({
      guildId: 'guild', scopeType: 'global', scopeId: '*', role,
      providerId: selected.id, modelKey: index % 2 === 0 ? 'model-a' : 'model-b',
    }, 'admin');
  }
  assert.deepEqual(
    roles.map((role) => store.resolveBinding('guild', null, role).modelKey),
    ['model-a', 'model-b', 'model-a', 'model-b'],
  );
  store.close();
});

test('removing a model from the catalog clears stale role bindings', () => {
  const store = new ProviderStore(':memory:');
  const selected = provider(store);
  store.setBinding({ guildId: 'guild', scopeType: 'global', scopeId: '*', role: 'backend', providerId: selected.id, modelKey: 'model-b' }, 'admin');
  store.replaceModels(selected.id, [{ modelKey: 'model-a' }], 'admin');
  assert.equal(store.resolveBinding('guild', null, 'backend'), null);
  store.close();
});
