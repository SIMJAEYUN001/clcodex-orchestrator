import assert from 'node:assert/strict';
import test from 'node:test';
import { assertTaskTraceability } from '../src/specs/task-graph.js';

const requirements = '# Requirements\n\n## REQ-001\nBackend endpoint.\n\n## REQ-002\nFrontend screen.';
const design = '# Design\n\nREQ-001 maps to API.\nREQ-002 maps to UI.';

function task(id, role, requirementRefs, fileScope, dependencies = []) {
  return {
    id,
    role,
    title: id,
    description: `Implement ${id}`,
    dependencies,
    requirementRefs,
    acceptanceCriteria: ['Observable behavior is verified'],
    fileScope,
    testCommands: ['npm test'],
  };
}

test('spec task graph computes dependency waves and preserves role ownership', () => {
  const tasks = assertTaskTraceability({ tasks: [
    task('backend-api', 'backend', ['REQ-001'], ['src/server/**']),
    task('frontend-ui', 'frontend', ['REQ-002'], ['src/client/**'], ['backend-api']),
  ] }, requirements, design);
  assert.deepEqual(tasks.map((item) => [item.taskKey, item.wave]), [['backend-api', 0], ['frontend-ui', 1]]);
});

test('same-wave overlapping scopes and orchestrator-owned paths are rejected', () => {
  assert.throws(() => assertTaskTraceability({ tasks: [
    task('backend-api', 'backend', ['REQ-001'], ['src/shared/**']),
    task('frontend-ui', 'frontend', ['REQ-002'], ['src/shared/components/**']),
  ] }, requirements, design), /overlap/);
  assert.throws(() => assertTaskTraceability({ tasks: [
    task('docs-edit', 'backend', ['REQ-001', 'REQ-002'], ['README.md']),
  ] }, requirements, design), /orchestrator-owned/);
});
