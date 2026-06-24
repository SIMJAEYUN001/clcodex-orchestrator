export const SPEC_STATUS = Object.freeze({
  PLANNING: 'planning',
  AWAITING_APPROVAL: 'awaiting_approval',
  READY: 'ready',
  RUNNING: 'running',
  REVIEW: 'review',
  MEDIATING: 'mediating',
  BLOCKED: 'blocked',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

export const TASK_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  MERGED: 'merged',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
});

export const SPEC_KIND = Object.freeze({
  FEATURE: 'feature',
  BUGFIX: 'bugfix',
});

export const SPEC_WORKFLOW = Object.freeze({
  REQUIREMENTS_FIRST: 'requirements-first',
  DESIGN_FIRST: 'design-first',
  QUICK_PLAN: 'quick-plan',
});

export function initialPhase(kind, workflow) {
  if (workflow === SPEC_WORKFLOW.QUICK_PLAN) return 'quick-plan';
  if (workflow === SPEC_WORKFLOW.DESIGN_FIRST) return 'design';
  return kind === SPEC_KIND.BUGFIX ? 'bugfix' : 'requirements';
}

export function artifactForPhase(phase) {
  if (phase === 'requirements') return 'requirements';
  if (phase === 'bugfix') return 'bugfix';
  if (phase === 'design') return 'design';
  if (phase === 'tasks' || phase === 'quick-plan') return 'manifest';
  return null;
}

export function nextPhase(spec) {
  if (spec.workflow === SPEC_WORKFLOW.REQUIREMENTS_FIRST) {
    if (spec.phase === 'requirements' || spec.phase === 'bugfix') return 'design';
    if (spec.phase === 'design') return 'tasks';
  }
  if (spec.workflow === SPEC_WORKFLOW.DESIGN_FIRST) {
    if (spec.phase === 'design') return spec.kind === SPEC_KIND.BUGFIX ? 'bugfix' : 'requirements';
    if (spec.phase === 'requirements' || spec.phase === 'bugfix') return 'tasks';
  }
  return null;
}

export function isTerminalSpecStatus(status) {
  return status === SPEC_STATUS.COMPLETED || status === SPEC_STATUS.CANCELLED;
}
