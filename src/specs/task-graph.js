const TASK_ID = /^[a-z][a-z0-9-]{1,79}$/;
const REQUIREMENT_ID = /\b(?:REQ|NFR|BUG)-\d{3,}\b/g;
const ORCHESTRATOR_OWNED = [
  /^README(?:\.|$)/i,
  /^docs\//i,
  /^\.clcodex\//i,
  /^\.github\//i,
];

function strings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const result = [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))];
  if (!allowEmpty && result.length === 0) throw new Error(`${label} cannot be empty`);
  return result;
}

function requirementIds(markdown) {
  return new Set(String(markdown || '').match(REQUIREMENT_ID) || []);
}

function normalizeTask(raw, index) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Task ${index + 1} must be an object`);
  const taskKey = String(raw.id || raw.taskKey || '').trim();
  if (!TASK_ID.test(taskKey)) throw new Error(`Invalid stable task ID: ${taskKey || '(empty)'}`);
  const role = String(raw.role || '').trim().toLowerCase();
  if (!['backend', 'frontend'].includes(role)) throw new Error(`Task ${taskKey} role must be backend or frontend`);
  const title = String(raw.title || '').trim();
  const description = String(raw.description || '').trim();
  if (!title || !description) throw new Error(`Task ${taskKey} requires title and description`);
  const dependencies = strings(raw.dependencies || [], `Task ${taskKey} dependencies`, { allowEmpty: true });
  const requirementRefs = strings(raw.requirementRefs || [], `Task ${taskKey} requirementRefs`);
  const acceptanceCriteria = strings(raw.acceptanceCriteria || [], `Task ${taskKey} acceptanceCriteria`);
  const fileScope = strings(raw.fileScope || [], `Task ${taskKey} fileScope`).map((item) => item.replace(/\\/g, '/').replace(/^\.\//, ''));
  const testCommands = strings(raw.testCommands || [], `Task ${taskKey} testCommands`, { allowEmpty: true });
  for (const scope of fileScope) {
    if (scope.startsWith('/') || scope.includes('..')) throw new Error(`Task ${taskKey} has an unsafe file scope: ${scope}`);
    if (ORCHESTRATOR_OWNED.some((pattern) => pattern.test(scope))) {
      throw new Error(`Task ${taskKey} claims an orchestrator-owned path: ${scope}`);
    }
  }
  return { taskKey, role, title, description, dependencies, requirementRefs, acceptanceCriteria, fileScope, testCommands };
}

function computeWaves(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskKey, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) throw new Error(`Task ${task.taskKey} depends on missing task ${dependency}`);
      if (dependency === task.taskKey) throw new Error(`Task ${task.taskKey} cannot depend on itself`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const wave = new Map();
  function visit(task) {
    if (visiting.has(task.taskKey)) throw new Error(`Task dependency cycle includes ${task.taskKey}`);
    if (visited.has(task.taskKey)) return wave.get(task.taskKey);
    visiting.add(task.taskKey);
    const value = task.dependencies.length
      ? Math.max(...task.dependencies.map((id) => visit(byId.get(id)))) + 1
      : 0;
    visiting.delete(task.taskKey);
    visited.add(task.taskKey);
    wave.set(task.taskKey, value);
    return value;
  }
  for (const task of tasks) visit(task);
  return tasks.map((task) => ({ ...task, wave: wave.get(task.taskKey) }));
}

function staticPrefix(pattern) {
  const normalized = pattern.replace(/\\/g, '/');
  const index = normalized.search(/[?*[]/);
  return (index < 0 ? normalized : normalized.slice(0, index)).replace(/\/+$/, '');
}

function scopesCouldOverlap(a, b) {
  const left = staticPrefix(a);
  const right = staticPrefix(b);
  if (!left || !right) return true;
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function assertWaveScopes(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.wave)) groups.set(task.wave, []);
    groups.get(task.wave).push(task);
  }
  for (const [wave, items] of groups) {
    for (let left = 0; left < items.length; left += 1) {
      for (let right = left + 1; right < items.length; right += 1) {
        for (const a of items[left].fileScope) {
          for (const b of items[right].fileScope) {
            if (scopesCouldOverlap(a, b)) {
              throw new Error(`Wave ${wave} file scopes may overlap: ${items[left].taskKey}:${a} and ${items[right].taskKey}:${b}`);
            }
          }
        }
      }
    }
  }
}

export function assertTaskTraceability(manifest, requirementsMarkdown, designMarkdown) {
  const source = Array.isArray(manifest) ? manifest : manifest?.tasks;
  if (!Array.isArray(source) || source.length === 0) throw new Error('Task manifest must contain at least one task');
  const tasks = source.map(normalizeTask);
  const ids = new Set();
  for (const task of tasks) {
    if (ids.has(task.taskKey)) throw new Error(`Duplicate task ID: ${task.taskKey}`);
    ids.add(task.taskKey);
  }
  const approved = requirementIds(requirementsMarkdown);
  if (!approved.size) throw new Error('Requirements artifact contains no stable REQ/NFR/BUG IDs');
  const design = requirementIds(designMarkdown);
  for (const id of approved) {
    if (!design.has(id)) throw new Error(`Design does not trace approved requirement ${id}`);
  }
  const covered = new Set();
  for (const task of tasks) {
    for (const id of task.requirementRefs) {
      if (!approved.has(id)) throw new Error(`Task ${task.taskKey} references unknown requirement ${id}`);
      if (!design.has(id)) throw new Error(`Task ${task.taskKey} references ${id}, which is absent from design`);
      covered.add(id);
    }
  }
  for (const id of approved) if (!covered.has(id)) throw new Error(`Approved requirement ${id} is not assigned to any task`);
  const withWaves = computeWaves(tasks);
  assertWaveScopes(withWaves);
  return withWaves;
}

export const __test = { requirementIds, computeWaves, scopesCouldOverlap, staticPrefix };
