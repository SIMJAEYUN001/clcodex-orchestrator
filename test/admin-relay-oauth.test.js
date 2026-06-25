import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminRelayServer } from '../relay/server.js';

function config() {
  return {
    host: '127.0.0.1',
    port: 0,
    activityOrigins: ['https://activity.example'],
    devices: new Map([['installation', 'x'.repeat(48)]]),
    discordClientId: '123456789012345678',
    discordClientSecret: 'secret',
    oauthRedirectUri: null,
    oauthSessionTtlMs: 120_000,
    activitySessionTtlMs: 300_000,
    maxPayloadBytes: 1_000_000,
    maxMessagesPerMinute: 180,
  };
}

test('relay OAuth exchange follows the Discord Activity server flow and exposes the result only to the exact Activity origin', async () => {
  const calls = [];
  const relay = new AdminRelayServer(config(), {
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith('/oauth2/token')) {
        return new Response(JSON.stringify({ access_token: 'discord-access', token_type: 'Bearer', expires_in: 300 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ id: 'admin', username: 'admin' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    logger: { warn() {}, error() {} },
  });
  try {
    await relay.start();
    const { port } = relay.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
      method: 'POST',
      headers: { origin: 'https://activity.example', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'one-time-code' }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://activity.example');
    const result = await response.json();
    assert.equal(result.access_token, 'discord-access');
    assert.ok(result.relay_session_token);
    const tokenRequest = calls[0];
    const params = new URLSearchParams(String(tokenRequest.options.body));
    assert.equal(params.get('code'), 'one-time-code');
    assert.equal(params.get('client_id'), '123456789012345678');
    assert.equal(params.get('grant_type'), 'authorization_code');
    assert.equal(params.has('code_verifier'), false);
    assert.equal(params.has('redirect_uri'), false);

    const rejected = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
      method: 'POST',
      headers: { origin: 'https://attacker.example', 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'unused' }),
    });
    assert.equal(rejected.status, 403);
    assert.equal(calls.length, 2, 'disallowed origin must not reach Discord OAuth');
  } finally {
    await relay.close();
  }
});

test('relay rejects missing OAuth codes before contacting Discord', async () => {
  let called = false;
  const relay = new AdminRelayServer(config(), {
    fetchImpl: async () => { called = true; throw new Error('must not be called'); },
    logger: { warn() {}, error() {} },
  });
  try {
    await relay.start();
    const { port } = relay.address();
    const response = await fetch(`http://127.0.0.1:${port}/v1/oauth/token`, {
      method: 'POST',
      headers: { origin: 'https://activity.example', 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    await relay.close();
  }
});
