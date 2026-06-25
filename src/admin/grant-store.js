import { randomBytes, randomUUID } from 'node:crypto';

export class AdminGrantStore {
  constructor({ grantTtlMs = 60_000, sessionTtlMs = 300_000 } = {}) {
    this.grantTtlMs = grantTtlMs;
    this.sessionTtlMs = sessionTtlMs;
    this.grants = new Map();
  }

  issue({ guildId, userId, threadId = null }) {
    this.sweep();
    const now = Date.now();
    const grant = {
      id: randomUUID(),
      nonce: randomBytes(16).toString('base64url'),
      guildId: String(guildId),
      userId: String(userId),
      threadId: threadId ? String(threadId) : null,
      createdAt: now,
      expiresAt: now + this.grantTtlMs,
      sessionExpiresAt: now + this.sessionTtlMs,
      consumedAt: null,
    };
    for (const [id, current] of this.grants) {
      if (current.guildId === grant.guildId && current.userId === grant.userId && !current.consumedAt) {
        this.grants.delete(id);
      }
    }
    this.grants.set(grant.id, grant);
    return { ...grant };
  }

  consume({ guildId, userId, threadId = null }) {
    this.sweep();
    const candidates = [...this.grants.values()]
      .filter((grant) => !grant.consumedAt
        && grant.guildId === String(guildId)
        && grant.userId === String(userId)
        && (!grant.threadId || grant.threadId === String(threadId || '')))
      .sort((a, b) => b.createdAt - a.createdAt);
    const grant = candidates[0];
    if (!grant) throw new Error('유효한 /admin 실행 grant가 없습니다. Discord에서 /admin을 다시 실행하세요.');
    grant.consumedAt = Date.now();
    return { ...grant };
  }

  revoke(grantId) {
    this.grants.delete(String(grantId || ''));
  }

  sweep() {
    const now = Date.now();
    for (const [id, grant] of this.grants) {
      const deadline = grant.consumedAt ? grant.sessionExpiresAt : grant.expiresAt;
      if (deadline <= now) this.grants.delete(id);
    }
  }

  pendingCount() {
    this.sweep();
    return [...this.grants.values()].filter((grant) => !grant.consumedAt).length;
  }

  clear() {
    this.grants.clear();
  }
}
