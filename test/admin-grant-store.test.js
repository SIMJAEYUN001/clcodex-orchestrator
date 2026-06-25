import assert from 'node:assert/strict';
import test from 'node:test';
import { AdminGrantStore } from '../src/admin/grant-store.js';

test('/admin grant is bound to one guild/user pair and can be consumed only once', () => {
  const store = new AdminGrantStore({ grantTtlMs: 60_000, sessionTtlMs: 300_000 });
  const grant = store.issue({ guildId: 'guild', userId: 'admin', threadId: 'thread' });
  assert.throws(() => store.consume({ guildId: 'guild', userId: 'other', threadId: 'thread' }), /grant/);
  assert.throws(() => store.consume({ guildId: 'guild', userId: 'admin', threadId: 'different-thread' }), /grant/);
  const consumed = store.consume({ guildId: 'guild', userId: 'admin', threadId: 'thread' });
  assert.equal(consumed.id, grant.id);
  assert.equal(consumed.threadId, 'thread');
  assert.throws(() => store.consume({ guildId: 'guild', userId: 'admin', threadId: 'thread' }), /grant/);
});
