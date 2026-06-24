import assert from 'node:assert/strict';
import test from 'node:test';
import { SpecCoordinator } from '../src/specs/coordinator.js';

test('dispatchReady starts no more tasks than the selected orchestration parallel limit', async () => {
  const started = [];
  const events = [];
  const spec = { id: 'spec', projectId: 'project', guildId: 'guild', threadId: 'thread', status: 'running' };
  const ready = [1, 2, 3, 4].map((index) => ({ id: `task-${index}`, worktreeDir: null, branch: null }));
  const coordinator = new SpecCoordinator({
    store: {
      requireSpec: () => spec,
      requireProject: () => ({ id: 'project' }),
      runningTasks: () => [{ id: 'already-running' }],
      readyTasks: () => ready,
      allTasksMerged: () => false,
      appendEvent: (event) => events.push(event),
    },
    repository: {}, workspaceManager: {}, harnessRuntime: {}, roleBots: null,
    toolServer: { listen: async () => {}, close: async () => {} },
    toolScript: '/tmp/tool.mjs',
    policyStore: { resolvePolicy: () => ({ settings: { maxParallelAgents: 3 } }) },
  });
  coordinator.startTask = (_specId, taskId) => { started.push(taskId); return taskId; };
  const handles = await coordinator.dispatchReady('spec');
  assert.deepEqual(started, ['task-1', 'task-2']);
  assert.equal(handles.length, 2);
  assert.equal(events.at(-1).eventType, 'execution.parallel_limit_applied');
  assert.equal(events.at(-1).details.waiting, 2);
});
