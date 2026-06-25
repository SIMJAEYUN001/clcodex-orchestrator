import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminControlPlane } from '../src/admin/control-plane.js';

function plane() {
  const calls = [];
  const manager = {
    async status(harness) { calls.push(['status', harness]); return { harness, loggedIn: true, output: 'Logged in' }; },
    start(harness, options) { calls.push(['start', harness, options.actorId]); return { id: 's1', harness, status: 'running', output: 'Open URL' }; },
    describe(id) { calls.push(['poll', id]); return { id, harness: 'codex', status: 'running', output: 'Device code' }; },
    input(id, data) { calls.push(['input', id, data]); return { id, harness: 'codex', status: 'running', output: data }; },
    stop(id) { calls.push(['stop', id]); return { id, harness: 'codex', status: 'stopped', output: '' }; },
    close() { calls.push(['close']); },
  };
  const control = new AdminControlPlane({
    service: { harnessRoot: '/tmp/harness', list: () => [] },
    store: { getBinding: () => null, resolveBinding: () => null, listAudit: () => [] },
    cliOauthManager: manager,
  });
  const sessionId = control.openSession({ guildId: 'g', userId: 'u' });
  return { control, sessionId, calls };
}

test('admin control plane exposes CLI OAuth status/start/poll/input/stop RPCs', async () => {
  const { control, sessionId, calls } = plane();
  assert.deepEqual(await control.invoke(sessionId, 'cliOAuth.status', { harness: 'codex' }), { ok: true, status: { harness: 'codex', loggedIn: true, output: 'Logged in' } });
  assert.equal((await control.invoke(sessionId, 'cliOAuth.start', { harness: 'claude' })).session.status, 'running');
  assert.equal((await control.invoke(sessionId, 'cliOAuth.poll', { sessionId: 's1' })).session.output, 'Device code');
  assert.equal((await control.invoke(sessionId, 'cliOAuth.input', { sessionId: 's1', data: '1234\n' })).session.output, '1234\n');
  assert.equal((await control.invoke(sessionId, 'cliOAuth.stop', { sessionId: 's1' })).session.status, 'stopped');
  assert.deepEqual(calls.map((item) => item[0]), ['status', 'start', 'poll', 'input', 'stop']);
});

test('admin control plane requires harness for CLI OAuth start/status', async () => {
  const { control, sessionId } = plane();
  await assert.rejects(() => control.invoke(sessionId, 'cliOAuth.start', {}), /harness is required/i);
  await assert.rejects(() => control.invoke(sessionId, 'cliOAuth.status', { harness: 'other' }), /Harness must be codex or claude/);
});
