import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { ProviderGateway } from '../src/providers/gateway.js';

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

for (const fixture of [
  { authType: 'bearer', expected: ['authorization', 'Bearer upstream-secret'] },
  { authType: 'api-key', authHeader: 'x-custom-key', expected: ['x-custom-key', 'upstream-secret'] },
  {
    authType: 'basic', authUsername: 'proxy-user',
    expected: ['authorization', `Basic ${Buffer.from('proxy-user:upstream-secret').toString('base64')}`],
  },
]) {
  test(`provider gateway rewrites ${fixture.authType} authentication and hides the upstream secret from clients`, async () => {
    let received;
    const upstream = http.createServer((request, response) => {
      received = request.headers;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true }));
    });
    const upstreamOrigin = await listen(upstream);
    const gateway = new ProviderGateway({
      networkPolicy: { assertAllowed: async (raw) => new URL(raw) },
      host: '127.0.0.1',
      port: 0,
    });
    await gateway.start();
    const route = gateway.createRoute({
      profile: {
        baseUrl: upstreamOrigin,
        protocol: 'openai',
        authType: fixture.authType,
        authHeader: fixture.authHeader,
        authUsername: fixture.authUsername,
      },
      credential: 'upstream-secret',
      sessionId: 'session-1',
    });
    const response = await fetch(`${route.baseUrl}/v1/test`, {
      headers: { authorization: `Bearer ${route.token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(received[fixture.expected[0]], fixture.expected[1]);
    assert.notEqual(received.authorization, `Bearer ${route.token}`);
    route.revoke();
    await gateway.close();
    await new Promise((resolve) => upstream.close(resolve));
  });
}
