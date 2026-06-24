import { roleDefinition } from '../roles.js';

const ANSI_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const SK_SECRET = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const BEARER_SECRET = /(authorization\s*:\s*bearer\s+)[^\s]+/gi;
const NAMED_SECRET = /((?:api[_-]?key|token|secret)\s*[=:]\s*)[^\s,;]+/gi;

export function sanitizeRoleOutput(value, maxLength = 3500) {
  let result = String(value ?? '')
    .replace(ANSI_PATTERN, '')
    .replace(/\r/g, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(SK_SECRET, '[REDACTED]')
    .replace(BEARER_SECRET, '$1[REDACTED]')
    .replace(NAMED_SECRET, '$1[REDACTED]')
    .replace(/```/g, '`\u200b``');
  if (result.length > maxLength) result = `…${result.slice(-(maxLength - 1))}`;
  return result.trim();
}

function compact(value, maxLength) {
  const text = String(value ?? '').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function stateLabel(state) {
  return {
    queued: '대기',
    running: '작업 중',
    completed: '완료',
    failed: '실패',
    interrupted: '중단',
    review: '리뷰 중',
  }[state] || state;
}

export class RoleOutputRouter {
  constructor({ roleBots, store, flushIntervalMs = 1500 }) {
    this.roleBots = roleBots;
    this.store = store;
    this.flushIntervalMs = flushIntervalMs;
  }

  createTaskStream(input) {
    const definition = roleDefinition(input.role);
    const state = {
      input,
      definition,
      status: input.status || 'running',
      rawOutput: '',
      output: '',
      summary: input.summary || '',
      commitSha: null,
      timer: null,
      message: null,
      messagePromise: null,
      closed: false,
    };
    this.log(state, 'task.started', state.summary || input.title || '작업 시작');
    state.messagePromise = this.roleBots.send(input.role, input.channelId, this.payload(state));
    state.messagePromise
      .then((message) => { state.message = message; })
      .catch((error) => console.error(
        `[${input.role}] Failed to post task message:`,
        error instanceof Error ? error.message : String(error),
      ));

    return {
      write: (chunk) => {
        if (state.closed) return;
        state.rawOutput = `${state.rawOutput}\n${String(chunk ?? '')}`.slice(-12_000);
        state.output = sanitizeRoleOutput(state.rawOutput, 3500);
        if (!state.output) return;
        this.schedule(state);
      },
      finish: (details = {}) => this.close(state, 'completed', details),
      fail: (details = {}) => this.close(state, details.interrupted ? 'interrupted' : 'failed', details),
    };
  }

  schedule(state) {
    if (state.timer || state.closed) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flush(state);
    }, this.flushIntervalMs);
    state.timer.unref?.();
  }

  async flush(state) {
    try {
      const message = state.message || await state.messagePromise;
      await message.edit(this.payload(state));
    } catch (error) {
      console.error(
        `[${state.input.role}] Failed to update task message:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async close(state, status, details) {
    if (state.closed) return;
    state.closed = true;
    if (state.timer) clearTimeout(state.timer);
    state.timer = null;
    state.status = status;
    state.summary = sanitizeRoleOutput(details.summary || state.summary || '', 800);
    state.commitSha = details.commitSha || null;
    if (details.output) {
      state.rawOutput = String(details.output);
      state.output = sanitizeRoleOutput(details.output, 3500);
    }
    await this.flush(state);
    this.log(state, `task.${status}`, state.summary || state.output || state.input.title || status);
  }

  payload(state) {
    const { input, definition } = state;
    const fields = [
      { name: '상태', value: stateLabel(state.status), inline: true },
      { name: 'Task', value: input.taskId ? `\`${compact(input.taskId, 100)}\`` : '미지정', inline: true },
      { name: 'Goal', value: input.goalId ? `\`${compact(input.goalId, 100)}\`` : '미지정', inline: true },
      { name: '하네스', value: compact(input.harness || '미지정', 100), inline: true },
      { name: 'Provider', value: compact(input.providerName || '미지정', 100), inline: true },
      { name: 'Provider rev', value: input.providerRevision == null ? '미지정' : String(input.providerRevision), inline: true },
      { name: 'Model', value: input.model ? `\`${compact(input.model, 100)}\`` : '미지정', inline: true },
    ];
    if (input.branch) fields.push({ name: '작업 브랜치', value: `\`${compact(input.branch, 900)}\``, inline: false });
    if (state.commitSha) fields.push({ name: 'Commit', value: `\`${compact(state.commitSha, 900)}\``, inline: false });
    if (state.summary) fields.push({ name: '요약', value: state.summary.slice(0, 1024), inline: false });
    return {
      embeds: [{
        color: definition.color,
        title: `${definition.label} · ${compact(input.title || '작업', 220)}`,
        description: state.output ? `\`\`\`text\n${state.output.slice(-3500)}\n\`\`\`` : undefined,
        fields,
        footer: { text: `${definition.label} · 작업 이력` },
        timestamp: new Date().toISOString(),
      }],
    };
  }

  log(state, eventType, summary) {
    this.store.appendWorkEvent({
      guildId: state.input.guildId,
      threadId: state.input.channelId,
      goalId: state.input.goalId || null,
      taskId: state.input.taskId || null,
      role: state.input.role,
      eventType,
      summary: sanitizeRoleOutput(summary, 1000),
      providerId: state.input.providerId || null,
      modelKey: state.input.model || null,
      botUserId: this.roleBots.identity(state.input.role)?.id || null,
      messageId: state.message?.id || null,
      metadata: {
        branch: state.input.branch || null,
        commitSha: state.commitSha || null,
        harness: state.input.harness || null,
        providerRevision: state.input.providerRevision ?? null,
      },
    });
  }
}

export const __test = { stateLabel };
