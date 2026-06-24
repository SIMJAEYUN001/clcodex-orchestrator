import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminSetupServer } from '../src/admin/setup-server.js';
import { OrchestrationPolicyStore } from '../src/orchestration/policy-store.js';

function tokenFrom(url) {
  return new URLSearchParams(new URL(url).hash.slice(1)).get('token');
}

test('admin server authenticates the one-time Discord session and persists orchestration choices', async () => {
  const policyStore = new OrchestrationPolicyStore(':memory:');
  const store = {
    getBinding: () => null,
    resolveBinding: () => null,
    listAudit: () => [],
  };
  const server = new AdminSetupServer({
    service: { list: () => [], store },
    store,
    policyStore,
    specStore: { listSpecsForThread: () => [] },
    harnessRuntime: { listSessions: () => [] },
    host: '127.0.0.1',
    port: 0,
  });
  try {
    const origin = await server.start();
    const issued = server.issueSession({ guildId: 'guild', userId: 'admin', threadId: 'thread' });
    const token = tokenFrom(issued.url);
    const unauthorized = await fetch(`${origin}/api/bootstrap`);
    assert.equal(unauthorized.status, 401);

    const bootstrap = await fetch(`${origin}/api/bootstrap`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(bootstrap.status, 200);
    const initial = await bootstrap.json();
    assert.equal(initial.session.threadId, 'thread');
    assert.equal(initial.policies.policy.settings.preset, 'balanced');

    const saved = await fetch(`${origin}/api/policy/save`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        scopeType: 'thread', scopeId: 'thread',
        settings: { preset: 'rapid', maxParallelAgents: 4 },
      }),
    });
    assert.equal(saved.status, 200);
    const after = server.bootstrap(server.session({ headers: { authorization: `Bearer ${token}` } }).value);
    assert.equal(after.policies.policy.settings.preset, 'rapid');
    assert.equal(after.policies.policy.settings.maxParallelAgents, 4);
  } finally {
    await server.close();
    policyStore.close();
  }
});
