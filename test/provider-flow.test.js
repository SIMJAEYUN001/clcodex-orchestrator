import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProxyNetworkPolicy } from '../src/providers/network-policy.js';
import { ProviderService } from '../src/providers/service.js';
import { ProviderStore } from '../src/providers/store.js';
import { SecretVault } from '../src/providers/vault.js';
import { ROLES } from '../src/roles.js';

async function startModelServer() {
  let authorization;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-a' }, { id: 'model-b' }] }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${server.address().port}`,
    authorization: () => authorization,
  };
}

test('provider setup completes discovery, selected model persistence, and four-role bindings', async () => {
  const upstream = await startModelServer();
  const root = mkdtempSync(path.join(os.tmpdir(), 'clcodex-provider-flow-'));
  const store = new ProviderStore(':memory:');
  const vault = new SecretVault({ runtimeRoot: root });
  const service = new ProviderService({
    store,
    vault,
    networkPolicy: new ProxyNetworkPolicy({ allowLoopback: true, allowInsecureLoopback: true }),
  });
  const bindings = Object.fromEntries(ROLES.map((role, index) => [role, index % 2 ? 'model-b' : 'model-a']));
  const result = await service.createConfigured({
    guildId: 'guild',
    harness: 'codex',
    name: 'local proxy',
    baseUrl: upstream.url,
    modelsPath: '/v1/models',
    authType: 'bearer',
    credential: 'proxy-token',
    initialModel: 'model-a',
    selectedModels: ['model-a', 'model-b'],
    bindings,
    scopeType: 'global',
    scopeId: '*',
  }, 'admin');

  assert.equal(upstream.authorization(), 'Bearer proxy-token');
  assert.deepEqual(result.provider.models.map((item) => item.modelKey), ['model-a', 'model-b']);
  assert.deepEqual(
    ROLES.map((role) => store.resolveBinding('guild', null, role)?.modelKey),
    ROLES.map((role) => bindings[role]),
  );
  assert.equal(JSON.stringify(store.getSecret(result.provider.id)).includes('proxy-token'), false);

  store.close();
  await new Promise((resolve) => upstream.server.close(resolve));
});
