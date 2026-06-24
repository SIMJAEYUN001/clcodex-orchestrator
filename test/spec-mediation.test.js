import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SpecCoordinator } from '../src/specs/coordinator.js';
import { SPEC_STATUS, TASK_STATUS } from '../src/specs/constants.js';
import { SpecStore } from '../src/specs/store.js';

function fixture({ specStatus = SPEC_STATUS.RUNNING, taskStatus = TASK_STATUS.RUNNING } = {}) {
  const store = new SpecStore(':memory:');
  const worktreeDir = mkdtempSync(path.join(tmpdir(), 'clcodex-mediation-worktree-'));
  const project = store.createProject({
    guildId: 'guild', threadId: 'thread', name: 'project', rootDir: '/project', defaultBranch: 'main', createdBy: 'admin',
  });
  let spec = store.createSpec({
    projectId: project.id, guildId: 'guild', threadId: 'thread', slug: 'feature', kind: 'feature',
    workflow: 'quick-plan', objective: 'Implement feature', autoRun: false, createdBy: 'admin',
  });
  spec = store.updateSpec(spec.id, { phase: specStatus === SPEC_STATUS.REVIEW ? 'review' : 'execution', status: specStatus });
  let [task] = store.replaceTasks(spec.id, [{
    taskKey: 'backend-api', role: 'backend', title: 'API',
    description: 'Implement API\n\nReviewer rework request:\nAdd validation required by REQ-001',
    dependencies: [], requirementRefs: ['REQ-001'], acceptanceCriteria: ['Validation is observable'],
    fileScope: ['src/server/**'], testCommands: [], wave: 0,
  }], 'orchestrator');
  task = store.updateTask(spec.id, task.id, {
    status: taskStatus,
    worktreeDir,
    branch: 'agent/feature/backend-api-r2',
    commitSha: taskStatus === TASK_STATUS.MERGED ? 'old-task-commit' : null,
  });
  const calls = { workflows: 0, starts: [], posts: [], removed: 0, revoked: [] };
  const repository = {
    writeWorkflow() { calls.workflows += 1; },
    steeringPaths: () => [],
    artifactExists: () => false,
  };
  const workspaceManager = {
    createMediationSnapshot: () => ({ snapshot: '/mediation/snapshot', scratch: '/mediation/scratch', diffFile: '/mediation/change.diff' }),
    removeTaskWorktree: () => { calls.removed += 1; },
    integrationHead: () => 'integration-head',
  };
  const harnessRuntime = {
    start(input) {
      calls.starts.push(input);
      return {
        id: `session-${calls.starts.length}`,
        complete: async () => undefined,
        fail: async () => undefined,
        dispose: () => undefined,
        interrupt: () => undefined,
      };
    },
  };
  const roleBots = { async send(role, channelId, payload) { calls.posts.push({ role, channelId, payload }); } };
  const toolServer = {
    register: () => ({ token: 'tool-token', environment: { CLCODEX_TOOL_URL: 'http://tool', CLCODEX_TOOL_TOKEN: 'tool-token' } }),
    revoke: (token) => calls.revoked.push(token),
    listen: async () => 'http://tool',
    close: async () => undefined,
  };
  const coordinator = new SpecCoordinator({
    store, repository, workspaceManager, harnessRuntime, roleBots, toolServer, toolScript: '/tool.mjs',
  });
  const cleanup = () => { store.close(); rmSync(worktreeDir, { recursive: true, force: true }); };
  return { store, project, spec, task, coordinator, calls, cleanup };
}

test('reviewer rework verdict automatically queues and dispatches the assigned coder task', async () => {
  const { store, spec, task, coordinator, cleanup } = fixture({ specStatus: SPEC_STATUS.REVIEW, taskStatus: TASK_STATUS.MERGED });
  let dispatched = 0;
  coordinator.dispatchReady = async () => { dispatched += 1; return []; };
  const result = await coordinator.reviewVerdict(
    { role: 'reviewer', specId: spec.id },
    { verdict: 'rework', comments: 'REQ-001 validation is incomplete', taskIds: [task.taskKey] },
  );
  assert.equal(result.status, SPEC_STATUS.RUNNING);
  assert.equal(store.requireTask(spec.id, task.id).status, TASK_STATUS.QUEUED);
  assert.equal(dispatched, 1);
  cleanup();
});

test('coder dispute automatically starts an orchestrator-only mediation harness', async () => {
  const { store, spec, task, coordinator, calls, cleanup } = fixture();
  const result = await coordinator.raiseDispute(
    { role: 'backend', specId: spec.id, taskId: task.id },
    { reason: 'Reviewer instruction conflicts with REQ-001', evidence: 'tests/validation.test.js passes the approved case' },
  );
  assert.equal(result.automatic, true);
  assert.equal(store.requireSpec(spec.id).status, SPEC_STATUS.MEDIATING);
  assert.equal(calls.starts.length, 1);
  assert.equal(calls.starts[0].role, 'orchestrator');
  assert.match(calls.starts[0].initialPrompt, /dispute\.resolve/);
  assert.match(calls.starts[0].initialPrompt, /Reviewer instruction conflicts/);
  cleanup();
});

test('automatic reviewer decision reuses the rework worktree and restarts the coder', async () => {
  const { store, spec, task, coordinator, cleanup } = fixture();
  await coordinator.raiseDispute(
    { role: 'backend', specId: spec.id, taskId: task.id },
    { reason: 'scope conflict', evidence: 'REQ-001 and diff' },
  );
  let reassigned;
  coordinator.startTask = (specId, taskId, options) => { reassigned = { specId, taskId, options }; return {}; };
  const resolved = await coordinator.resolveDispute(
    { role: 'orchestrator', phase: 'mediation', specId: spec.id, taskId: task.id },
    { decision: 'reviewer', rationale: 'The validation is required by REQ-001.' },
  );
  assert.equal(resolved.status, SPEC_STATUS.RUNNING);
  assert.equal(store.requireTask(spec.id, task.id).status, TASK_STATUS.QUEUED);
  assert.equal(reassigned.options.reuseWorktree, true);
  cleanup();
});

test('automatic coder decision discards rework and re-enters review without manual mediation', async () => {
  const { store, spec, task, coordinator, calls, cleanup } = fixture();
  store.appendEvent({
    specId: spec.id, taskId: task.id, actorRole: 'backend', eventType: 'task.merged',
    details: { commitSha: 'accepted-old-commit' },
  });
  await coordinator.raiseDispute(
    { role: 'backend', specId: spec.id, taskId: task.id },
    { reason: 'Reviewer requests behavior prohibited by REQ-001', evidence: 'design section 3 and regression test' },
  );
  let dispatched = 0;
  coordinator.dispatchReady = async () => { dispatched += 1; return []; };
  await coordinator.resolveDispute(
    { role: 'orchestrator', phase: 'mediation', specId: spec.id, taskId: task.id },
    { decision: 'coder', rationale: 'The reviewer request expands behavior beyond approved REQ-001.' },
  );
  const updated = store.requireTask(spec.id, task.id);
  assert.equal(updated.status, TASK_STATUS.MERGED);
  assert.equal(updated.commitSha, 'accepted-old-commit');
  assert.equal(calls.removed, 1);
  assert.equal(dispatched, 1);
  cleanup();
});
