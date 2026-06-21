import assert from 'node:assert/strict';
import test from 'node:test';
import { RoleOutputRouter, sanitizeRoleOutput } from '../src/discord/role-output-router.js';

function fixture() {
  const sent = [];
  const edits = [];
  const events = [];
  const roleBots = {
    identity: (role) => ({ id: `${role}-bot`, ready: true }),
    async send(role, channelId, payload) {
      sent.push({ role, channelId, payload });
      return {
        async edit(next) {
          edits.push(next);
        },
      };
    },
  };
  const store = {
    appendWorkEvent(event) {
      events.push(event);
      return event;
    },
  };
  return { sent, edits, events, roleBots, store };
}

test('terminal output sanitizer removes ANSI and redacts credentials', () => {
  const output = sanitizeRoleOutput('\u001b[31mfailed\u001b[0m\nAuthorization: Bearer top-secret\napi_key=abcdef\nsk-example123456');
  assert.equal(output.includes('\u001b'), false);
  assert.equal(output.includes('top-secret'), false);
  assert.equal(output.includes('abcdef'), false);
  assert.equal(output.includes('sk-example123456'), false);
  assert.match(output, /Authorization: Bearer \[REDACTED\]/i);
});

test('work stream routes messages through the assigned role bot and records a role-scoped ledger', async () => {
  const { sent, edits, events, roleBots, store } = fixture();
  const router = new RoleOutputRouter({ roleBots, store, flushIntervalMs: 60_000 });
  const stream = router.createTaskStream({
    guildId: 'guild',
    channelId: 'thread',
    goalId: 'goal-1',
    taskId: 'backend-1',
    role: 'backend',
    title: 'DB migration',
    branch: 'agent/goal-1/backend-1',
    harness: 'codex',
    providerId: 'provider-1',
    providerName: 'GPT subscription',
    model: 'gpt-5.5-codex',
  });
  stream.write('running migration with token=should-not-leak');
  await stream.finish({ summary: 'migration complete', commitSha: 'abc123' });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].role, 'backend');
  assert.equal(sent[0].channelId, 'thread');
  assert.equal(edits.length, 1);
  const finalEmbed = edits[0].embeds[0];
  assert.match(finalEmbed.title, /백엔드 코더/);
  assert.equal(JSON.stringify(finalEmbed).includes('should-not-leak'), false);
  assert.equal(finalEmbed.fields.some((field) => field.name === 'Commit' && field.value.includes('abc123')), true);
  assert.deepEqual(events.map((event) => event.eventType), ['task.started', 'task.completed']);
  assert.equal(events.every((event) => event.role === 'backend'), true);
  assert.equal(events.every((event) => event.botUserId === 'backend-bot'), true);
  assert.equal(finalEmbed.description.length <= 4096, true);
  assert.equal(finalEmbed.fields.every((field) => field.value.length <= 1024), true);
});
