import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OrchestrationPolicyStore,
  validateRoleSettings,
} from '../src/orchestration/policy-store.js';

test('orchestration policy inherits global values and permits a thread override', () => {
  const store = new OrchestrationPolicyStore(':memory:');
  try {
    assert.equal(store.resolvePolicy('g', 't').settings.preset, 'balanced');
    store.setPolicy({
      guildId: 'g', scopeType: 'global', scopeId: '*',
      settings: { preset: 'strict-spec', maxParallelAgents: 2 },
    }, 'admin');
    assert.equal(store.resolvePolicy('g', 't').settings.maxParallelAgents, 2);
    store.setPolicy({
      guildId: 'g', scopeType: 'thread', scopeId: 't',
      settings: { preset: 'rapid', maxParallelAgents: 4 },
    }, 'admin');
    const resolved = store.resolvePolicy('g', 't');
    assert.equal(resolved.scopeType, 'thread');
    assert.equal(resolved.settings.workflow, 'quick-plan');
    assert.equal(resolved.settings.maxParallelAgents, 4);
  } finally {
    store.close();
  }
});

test('role runtime settings are independently scoped by role and thread', () => {
  const store = new OrchestrationPolicyStore(':memory:');
  try {
    store.setRoleSettings({
      guildId: 'g', scopeType: 'global', scopeId: '*', role: 'backend',
      settings: { codex: { reasoningEffort: 'xhigh', verbosity: 'high' } },
    }, 'admin');
    store.setRoleSettings({
      guildId: 'g', scopeType: 'thread', scopeId: 't', role: 'backend',
      settings: { codex: { sandboxMode: 'read-only' } },
    }, 'admin');
    const resolved = store.resolveRoleSettings('g', 't', 'backend');
    assert.equal(resolved.settings.codex.reasoningEffort, 'xhigh');
    assert.equal(resolved.settings.codex.verbosity, 'high');
    assert.equal(resolved.settings.codex.sandboxMode, 'read-only');
    assert.equal(store.resolveRoleSettings('g', 't', 'frontend').settings.codex.reasoningEffort, 'high');
  } finally {
    store.close();
  }
});

test('reviewer and orchestrator write boundaries cannot be weakened by the UI', () => {
  const reviewer = validateRoleSettings('reviewer', {
    claude: { permissionMode: 'bypassPermissions', disallowedTools: [] },
    codex: { approvalPolicy: 'on-request', sandboxMode: 'danger-full-access' },
  });
  assert.equal(reviewer.claude.permissionMode, 'plan');
  assert.equal(reviewer.claude.disallowedTools.includes('Write'), true);
  assert.equal(reviewer.codex.approvalPolicy, 'never');
  assert.equal(reviewer.codex.sandboxMode, 'read-only');

  const orchestrator = validateRoleSettings('orchestrator', {
    claude: { permissionMode: 'bypassPermissions' },
    codex: { sandboxMode: 'danger-full-access' },
  });
  assert.equal(orchestrator.claude.permissionMode, 'plan');
  assert.equal(orchestrator.codex.sandboxMode, 'read-only');
});
