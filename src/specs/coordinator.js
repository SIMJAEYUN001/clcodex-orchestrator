import path from 'node:path';
import { existsSync } from 'node:fs';
import {
  SPEC_STATUS,
  TASK_STATUS,
  artifactForPhase,
  isTerminalSpecStatus,
  nextPhase,
} from './constants.js';
import { mediationPrompt, planningPrompt, reviewPrompt, taskPrompt } from './prompts.js';
import { assertTaskTraceability } from './task-graph.js';

function slugify(value) {
  const normalized = String(value || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 56);
  return normalized || `spec-${Date.now().toString(36)}`;
}

function activeKey(specId, role, taskId = '') {
  return `${specId}:${role}:${taskId}`;
}

export class SpecCoordinator {
  constructor({
    store,
    repository,
    workspaceManager,
    harnessRuntime,
    roleBots,
    toolServer,
    toolScript,
    policyStore = null,
  }) {
    this.store = store;
    this.repository = repository;
    this.workspaceManager = workspaceManager;
    this.harnessRuntime = harnessRuntime;
    this.roleBots = roleBots;
    this.toolServer = toolServer;
    this.toolScript = path.resolve(toolScript);
    this.policyStore = policyStore;
    this.active = new Map();
    this.integrationQueues = new Map();
  }

  async initialize() {
    await this.toolServer.listen();
  }

  ensureProject({ guildId, threadId, name, actorId }) {
    const existing = this.store.projectForThread(guildId, threadId);
    if (existing) return existing;
    const rootDir = this.workspaceManager.initializeProject({ threadId, name });
    const project = this.store.createProject({
      guildId,
      threadId,
      name,
      rootDir,
      defaultBranch: 'main',
      createdBy: actorId,
    });
    this.repository.initializeProject(project);
    return project;
  }

  bindProject({ guildId, threadId, name, rootDir, actorId }) {
    const existing = this.store.projectForThread(guildId, threadId);
    if (existing) throw new Error('This forum thread already has a project binding');
    const validated = this.workspaceManager.bindExisting(rootDir);
    const project = this.store.createProject({
      guildId,
      threadId,
      name,
      rootDir: validated,
      defaultBranch: 'main',
      createdBy: actorId,
    });
    this.repository.initializeProject(project);
    return project;
  }

  deleteProject({ guildId, threadId, actorId, removeFiles = false }) {
    const project = this.store.projectForThread(guildId, threadId);
    if (!project) throw new Error('No project is bound to this forum thread');
    this.store.deleteProject(project.id, actorId);
    if (removeFiles) this.workspaceManager.deleteProject(project.rootDir);
    return project;
  }

  async createGoal({ guildId, threadId, projectName, objective, kind, workflow, autoRun, actorId }) {
    const policy = this.policyStore?.resolvePolicy(guildId, threadId) || {
      settings: { workflow: 'requirements-first', autoRun: false, maxParallelAgents: 3, preset: 'balanced' },
      scopeType: 'default',
      revision: 0,
    };
    const effectiveWorkflow = workflow || policy.settings.workflow;
    const effectiveAutoRun = autoRun == null ? policy.settings.autoRun : Boolean(autoRun);
    const current = this.store.currentSpecForThread(guildId, threadId);
    if (current && !isTerminalSpecStatus(current.status)) {
      throw new Error(`현재 스레드에 진행 중인 spec이 있습니다: ${current.slug} (${current.status})`);
    }
    const project = this.ensureProject({ guildId, threadId, name: projectName, actorId });
    const baseSlug = slugify(objective);
    const existing = this.store.listSpecsForThread(guildId, threadId, 100).map((item) => item.slug);
    let slug = baseSlug;
    let suffix = 2;
    while (existing.includes(slug)) slug = `${baseSlug}-${suffix++}`;
    const spec = this.store.createSpec({
      projectId: project.id,
      guildId,
      threadId,
      slug,
      kind,
      workflow: effectiveWorkflow,
      objective: String(objective).trim(),
      autoRun: effectiveAutoRun,
      createdBy: actorId,
    });
    this.repository.initializeSpec(project, spec);
    this.store.appendEvent({
      specId: spec.id,
      actorRole: 'orchestrator',
      actorId,
      eventType: 'orchestration.policy_applied',
      details: {
        preset: policy.settings.preset,
        workflow: effectiveWorkflow,
        autoRun: effectiveAutoRun,
        maxParallelAgents: policy.settings.maxParallelAgents,
        scopeType: policy.scopeType,
        revision: policy.revision,
      },
    });
    await this.postOrchestrator(threadId, {
      title: `사양 작성 시작 · ${slug}`,
      description: objective,
      fields: [
        { name: 'Spec', value: `\`${spec.id}\``, inline: true },
        { name: '유형', value: kind, inline: true },
        { name: '워크플로', value: effectiveWorkflow, inline: true },
        { name: '정책', value: `${policy.settings.preset} · 병렬 ${policy.settings.maxParallelAgents}`, inline: true },
      ],
    });
    this.startPlanning(spec.id);
    return this.store.requireSpec(spec.id);
  }

  startPlanning(specId) {
    const spec = this.store.requireSpec(specId);
    if (spec.status !== SPEC_STATUS.PLANNING) return null;
    const key = activeKey(spec.id, 'orchestrator', spec.phase);
    if (this.active.has(key)) return this.active.get(key).handle;
    const project = this.store.requireProject(spec.projectId);
    const planning = this.workspaceManager.createPlanningSnapshot(project, spec);
    const registration = this.toolServer.register({
      specId: spec.id,
      taskId: null,
      role: 'orchestrator',
      phase: spec.phase,
    });
    const prompt = planningPrompt({
      spec,
      project: { ...project, rootDir: planning.snapshot },
      phase: spec.phase,
      toolScript: this.toolScript,
      scratchDir: planning.scratch,
      guidancePaths: this.artifactPaths(project, spec)
        .map((file) => path.join(planning.snapshot, path.relative(project.rootDir, file))),
      taskCommandPrefixes: this.workspaceManager.allowedTaskCommandPrefixes,
    });
    const handle = this.harnessRuntime.start({
      guildId: spec.guildId,
      threadId: spec.threadId,
      role: 'orchestrator',
      cwd: planning.snapshot,
      goalId: spec.id,
      taskId: `spec-${spec.phase}`,
      title: `사양서 작성 · ${spec.phase}`,
      initialPrompt: prompt,
      extraEnvironment: { ...registration.environment, CLCODEX_SCRATCH_DIR: planning.scratch },
      onExit: (event) => {
        this.active.delete(key);
        this.toolServer.revoke(registration.token);
        const current = this.store.requireSpec(spec.id);
        if (current.status === SPEC_STATUS.PLANNING) {
          const reason = event.exitCode === 0
            ? 'Planning process exited without publishing a structured artifact'
            : `Planning process exited with ${event.exitCode}`;
          this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: reason }, {
            actorRole: 'orchestrator',
            eventType: 'planning.interrupted',
            details: { phase: current.phase, exitCode: event.exitCode, structuredCompletion: false },
          });
        }
      },
    });
    this.active.set(key, { handle, token: registration.token });
    return handle;
  }

  finishActive(specId, role, taskId, details, failed = false) {
    const key = activeKey(specId, role, taskId || '');
    const session = this.active.get(key);
    if (!session) return;
    this.active.delete(key);
    this.toolServer.revoke(session.token);
    const reporting = failed ? session.handle.fail(details) : session.handle.complete(details);
    Promise.resolve(reporting).finally(() => {
      const timer = setTimeout(() => session.handle.dispose(), 750);
      timer.unref?.();
    }).catch(() => undefined);
  }

  projectAndSpec(specId) {
    const spec = this.store.requireSpec(specId);
    return { spec, project: this.store.requireProject(spec.projectId) };
  }

  artifactPaths(project, spec) {
    const steering = this.repository.steeringPaths(project);
    const artifacts = ['requirements', 'bugfix', 'design', 'tasks', 'workflow']
      .filter((kind) => this.repository.artifactExists(project, spec, kind))
      .map((kind) => this.repository.artifactPath(project, spec, kind));
    return [...steering, ...artifacts];
  }

  async handleTool({ command, payload, context }) {
    if (command.startsWith('spec.')) {
      if (context.role !== 'orchestrator') throw new Error('Only the orchestrator can publish spec artifacts');
      if (command === 'spec.publish') return this.publishArtifact(context, payload);
      if (command === 'spec.publish-tasks') return this.publishTasks(context, payload);
      if (command === 'spec.publish-plan') return this.publishPlan(context, payload);
    }
    if (command === 'task.complete') return this.completeTask(context, payload);
    if (command === 'task.blocked') return this.blockTask(context, payload);
    if (command === 'review.verdict') return this.reviewVerdict(context, payload);
    if (command === 'dispute.raise') return this.raiseDispute(context, payload);
    if (command === 'dispute.resolve') return this.resolveDispute(context, payload);
    throw new Error(`Unsupported coordinator tool command: ${command}`);
  }

  async publishArtifact(context, payload) {
    const { spec, project } = this.projectAndSpec(context.specId);
    const expected = artifactForPhase(spec.phase);
    if (spec.status !== SPEC_STATUS.PLANNING || payload.artifact !== expected) {
      throw new Error(`Expected ${expected} during ${spec.phase}; received ${payload.artifact}`);
    }
    if (!String(payload.content || '').trim()) throw new Error('Published artifact is empty');
    this.repository.writeArtifact(project, spec, payload.artifact, payload.content, 'orchestrator', 'draft');
    const updated = this.store.updateSpec(spec.id, { status: SPEC_STATUS.AWAITING_APPROVAL, lastError: null }, {
      actorRole: 'orchestrator',
      eventType: 'artifact.published',
      details: { artifact: payload.artifact, phase: spec.phase },
    });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id));
    this.finishActive(spec.id, 'orchestrator', spec.phase, { summary: `${payload.artifact}.md 초안 게시 완료` });
    await this.postOrchestrator(spec.threadId, {
      title: `승인 대기 · ${payload.artifact}.md`,
      description: `\`/spec approve\`로 다음 단계 진행, \`/spec sync\`로 재생성할 수 있습니다.`,
      fields: [{ name: 'Spec', value: `\`${spec.id}\`` }],
    });
    return { specId: spec.id, status: updated.status, artifact: payload.artifact };
  }

  async publishTasks(context, payload) {
    const { spec, project } = this.projectAndSpec(context.specId);
    if (spec.status !== SPEC_STATUS.PLANNING || spec.phase !== 'tasks') throw new Error('Spec is not accepting a task manifest');
    const requirementKind = spec.kind === 'bugfix' ? 'bugfix' : 'requirements';
    if (!this.repository.artifactExists(project, spec, requirementKind) || !this.repository.artifactExists(project, spec, 'design')) {
      throw new Error('Task planning requires approved requirement and design artifacts');
    }
    const normalizedTasks = assertTaskTraceability(
      payload.manifest,
      this.repository.readArtifact(project, spec, requirementKind),
      this.repository.readArtifact(project, spec, 'design'),
    );
    this.workspaceManager.assertTaskCommands(normalizedTasks);
    const tasks = this.store.replaceTasks(spec.id, normalizedTasks, 'orchestrator');
    this.repository.writeTaskDocuments(project, spec, tasks, 'orchestrator');
    const updated = this.store.updateSpec(spec.id, { status: SPEC_STATUS.AWAITING_APPROVAL, lastError: null }, {
      actorRole: 'orchestrator',
      eventType: 'tasks.published',
      details: { count: tasks.length },
    });
    this.repository.writeWorkflow(project, updated, tasks);
    this.finishActive(spec.id, 'orchestrator', spec.phase, { summary: `작업 ${tasks.length}개 생성 완료` });
    await this.postOrchestrator(spec.threadId, {
      title: `작업 계획 승인 대기 · ${spec.slug}`,
      description: `${tasks.length}개 task가 dependency wave와 역할별 file scope로 생성되었습니다.`,
      fields: this.waveFields(tasks),
    });
    return { specId: spec.id, tasks: tasks.length, status: updated.status };
  }

  async publishPlan(context, payload) {
    const { spec, project } = this.projectAndSpec(context.specId);
    if (spec.status !== SPEC_STATUS.PLANNING || spec.phase !== 'quick-plan') throw new Error('Spec is not in quick-plan mode');
    if (spec.kind !== 'feature') throw new Error('Quick Plan is available only for feature specs');
    const normalizedTasks = assertTaskTraceability(payload.manifest, payload.requirements, payload.design);
    this.workspaceManager.assertTaskCommands(normalizedTasks);
    this.repository.writeArtifact(project, spec, 'requirements', payload.requirements, 'orchestrator', 'approved');
    this.repository.writeArtifact(project, spec, 'design', payload.design, 'orchestrator', 'approved');
    const tasks = this.store.replaceTasks(spec.id, normalizedTasks, 'orchestrator');
    this.repository.writeTaskDocuments(project, spec, tasks, 'orchestrator');
    const updated = this.store.updateSpec(spec.id, { phase: 'tasks', status: SPEC_STATUS.READY, lastError: null }, {
      actorRole: 'orchestrator',
      eventType: 'quick-plan.published',
      details: { count: tasks.length },
    });
    this.repository.writeWorkflow(project, updated, tasks);
    this.workspaceManager.prepareSpec(project, updated);
    this.finishActive(spec.id, 'orchestrator', spec.phase, { summary: `Quick Plan · 작업 ${tasks.length}개 생성 완료` });
    if (updated.autoRun) await this.runSpec(updated.id, updated.createdBy);
    return { specId: spec.id, tasks: tasks.length, status: updated.status };
  }

  async approve(specId, actorId) {
    const { spec, project } = this.projectAndSpec(specId);
    if (spec.status !== SPEC_STATUS.AWAITING_APPROVAL) throw new Error('Spec is not awaiting approval');
    const artifactKind = artifactForPhase(spec.phase);
    if (artifactKind !== 'manifest') this.store.setArtifactStatus(spec.id, artifactKind, 'approved', actorId);
    if (spec.phase === 'tasks') {
      const ready = this.store.updateSpec(spec.id, { status: SPEC_STATUS.READY, approvedBy: actorId }, {
        actorRole: 'orchestrator', actorId, eventType: 'tasks.approved', details: {},
      });
      this.repository.writeWorkflow(project, ready, this.store.listTasks(spec.id), actorId);
      this.workspaceManager.prepareSpec(project, ready);
      if (ready.autoRun) await this.runSpec(ready.id, actorId);
      return ready;
    }
    const phase = nextPhase(spec);
    if (!phase) throw new Error(`No next phase after ${spec.phase}`);
    const updated = this.store.updateSpec(spec.id, {
      phase,
      status: SPEC_STATUS.PLANNING,
      approvedBy: actorId,
      lastError: null,
      bumpRevision: true,
    }, {
      actorRole: 'orchestrator', actorId, eventType: 'phase.approved', details: { approved: spec.phase, next: phase },
    });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id), actorId);
    this.startPlanning(updated.id);
    return updated;
  }

  async sync(specId, actorId) {
    const { spec, project } = this.projectAndSpec(specId);
    if ([SPEC_STATUS.RUNNING, SPEC_STATUS.REVIEW].includes(spec.status)) throw new Error('Cannot regenerate tasks while execution or review is active');
    const updated = this.store.updateSpec(spec.id, {
      phase: 'tasks',
      status: SPEC_STATUS.PLANNING,
      approvedBy: actorId,
      lastError: null,
      bumpRevision: true,
    }, {
      actorRole: 'orchestrator', actorId, eventType: 'spec.sync_requested', details: {},
    });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id), actorId);
    this.startPlanning(updated.id);
    return updated;
  }

  async runSpec(specId, actorId) {
    const { spec, project } = this.projectAndSpec(specId);
    if (![SPEC_STATUS.READY, SPEC_STATUS.BLOCKED].includes(spec.status)) throw new Error(`Spec is not ready to run: ${spec.status}`);
    const tasks = this.store.listTasks(spec.id);
    if (!tasks.length) throw new Error('Spec has no executable tasks');
    const updated = this.store.updateSpec(spec.id, { phase: 'execution', status: SPEC_STATUS.RUNNING, lastError: null }, {
      actorRole: 'orchestrator', actorId, eventType: 'execution.started', details: { tasks: tasks.length },
    });
    this.workspaceManager.prepareSpec(project, updated);
    this.repository.writeWorkflow(project, updated, tasks, actorId);
    await this.dispatchReady(updated.id);
    return updated;
  }

  async dispatchReady(specId) {
    const { spec } = this.projectAndSpec(specId);
    if (spec.status !== SPEC_STATUS.RUNNING) return [];
    const policy = this.policyStore?.resolvePolicy(spec.guildId, spec.threadId)?.settings || { maxParallelAgents: 3 };
    const runningCount = this.store.runningTasks(spec.id).length;
    const slots = Math.max(0, policy.maxParallelAgents - runningCount);
    const ready = this.store.readyTasks(spec.id);
    const started = [];
    for (const task of ready.slice(0, slots)) {
      const reuseWorktree = Boolean(task.worktreeDir && task.branch && existsSync(task.worktreeDir));
      started.push(this.startTask(spec.id, task.id, { reuseWorktree }));
    }
    if (ready.length > slots) {
      this.store.appendEvent({
        specId: spec.id,
        actorRole: 'orchestrator',
        eventType: 'execution.parallel_limit_applied',
        details: { maxParallelAgents: policy.maxParallelAgents, runningCount, waiting: ready.length - slots },
      });
    }
    if (!started.length && runningCount === 0 && this.store.allTasksMerged(spec.id)) await this.startReview(spec.id);
    return started;
  }

  startTask(specId, taskId, { reuseWorktree = false } = {}) {
    const { spec, project } = this.projectAndSpec(specId);
    const task = this.store.requireTask(spec.id, taskId);
    const key = activeKey(spec.id, task.role, task.id);
    if (this.active.has(key)) return this.active.get(key).handle;
    let assignment;
    if (reuseWorktree && task.worktreeDir && task.branch && existsSync(task.worktreeDir)) {
      assignment = { worktree: task.worktreeDir, branch: task.branch };
    } else {
      assignment = this.workspaceManager.createTaskWorktree(project, spec, task);
    }
    const registration = this.toolServer.register({
      specId: spec.id,
      taskId: task.id,
      taskKey: task.taskKey,
      role: task.role,
    });
    const updated = this.store.updateTask(spec.id, task.id, {
      status: TASK_STATUS.RUNNING,
      worktreeDir: assignment.worktree,
      branch: assignment.branch,
      incrementAttempts: !reuseWorktree,
      lastError: null,
    }, {
      actorRole: 'orchestrator',
      eventType: reuseWorktree ? 'task.resumed' : 'task.dispatched',
      details: { role: task.role, branch: assignment.branch },
    });
    const prompt = taskPrompt({
      spec,
      task: updated,
      project,
      toolScript: this.toolScript,
      artifactPaths: this.artifactPaths(project, spec),
    });
    const handle = this.harnessRuntime.start({
      guildId: spec.guildId,
      threadId: spec.threadId,
      role: task.role,
      cwd: assignment.worktree,
      goalId: spec.id,
      taskId: task.taskKey,
      title: task.title,
      branch: assignment.branch,
      initialPrompt: prompt,
      extraEnvironment: registration.environment,
      onExit: (event) => {
        this.active.delete(key);
        this.toolServer.revoke(registration.token);
        const current = this.store.requireTask(spec.id, task.id);
        if (current.status === TASK_STATUS.RUNNING) {
          const reason = event.exitCode === 0
            ? 'Harness exited without task.complete or task.blocked'
            : `Harness exited with ${event.exitCode}`;
          this.store.updateTask(spec.id, task.id, {
            status: TASK_STATUS.BLOCKED,
            lastError: reason,
          }, {
            actorRole: task.role,
            eventType: 'task.interrupted',
            details: { exitCode: event.exitCode, structuredCompletion: false },
          });
          this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: `Task ${task.taskKey}: ${reason}` });
        }
      },
    });
    this.store.updateTask(spec.id, task.id, { sessionId: handle.id });
    this.active.set(key, { handle, token: registration.token });
    this.repository.writeWorkflow(project, spec, this.store.listTasks(spec.id));
    return handle;
  }

  enqueueIntegration(specId, operation) {
    const previous = this.integrationQueues.get(specId) || Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.integrationQueues.set(specId, current);
    current.finally(() => {
      if (this.integrationQueues.get(specId) === current) this.integrationQueues.delete(specId);
    }).catch(() => undefined);
    return current;
  }

  async completeTask(context, payload) {
    return this.enqueueIntegration(context.specId, () => this.completeTaskSerialized(context, payload));
  }

  async completeTaskSerialized(context, payload) {
    const { spec, project } = this.projectAndSpec(context.specId);
    const task = this.store.requireTask(spec.id, context.taskId);
    if (context.role !== task.role) throw new Error('Tool token role does not match the assigned task role');
    if (task.status !== TASK_STATUS.RUNNING) throw new Error(`Task is not running: ${task.status}`);
    try {
      const finalized = this.workspaceManager.finalizeTask(project, spec, task);
      const integratedCommit = this.workspaceManager.integrateTask(project, spec, task, finalized.commitSha);
      const updatedTask = this.store.updateTask(spec.id, task.id, {
        status: TASK_STATUS.MERGED,
        commitSha: finalized.commitSha,
        sessionId: null,
        lastError: null,
      }, {
        actorRole: task.role,
        eventType: 'task.merged',
        details: {
          summary: payload.summary || '',
          commitSha: finalized.commitSha,
          integratedCommit,
          files: finalized.files,
        },
      });
      this.finishActive(spec.id, task.role, task.id, { summary: payload.summary || task.title, commitSha: finalized.commitSha });
      this.workspaceManager.removeTaskWorktree(project, updatedTask);
      this.repository.writeWorkflow(project, spec, this.store.listTasks(spec.id));
      this.workspaceManager.syncControlDocs(project, spec);
      await this.dispatchReady(spec.id);
      return { taskId: task.taskKey, commitSha: finalized.commitSha, integratedCommit };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.store.updateTask(spec.id, task.id, { status: TASK_STATUS.BLOCKED, lastError: message }, {
        actorRole: task.role,
        eventType: 'task.integration_failed',
        details: { error: message },
      });
      this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: message });
      this.finishActive(spec.id, task.role, task.id, { summary: message }, true);
      throw error;
    }
  }

  async blockTask(context, payload) {
    const { spec, project } = this.projectAndSpec(context.specId);
    const task = this.store.requireTask(spec.id, context.taskId);
    if (context.role !== task.role) throw new Error('Tool token role does not match the assigned task role');
    const reason = String(payload.reason || '').trim();
    this.store.updateTask(spec.id, task.id, { status: TASK_STATUS.BLOCKED, lastError: reason }, {
      actorRole: task.role,
      eventType: 'task.blocked',
      details: { reason },
    });
    const updated = this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: `Task ${task.taskKey}: ${reason}` });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id));
    this.finishActive(spec.id, task.role, task.id, { summary: reason }, true);
    return { taskId: task.taskKey, status: TASK_STATUS.BLOCKED };
  }

  async startReview(specId) {
    const { spec, project } = this.projectAndSpec(specId);
    const current = this.store.requireSpec(spec.id);
    if (![SPEC_STATUS.RUNNING, SPEC_STATUS.REVIEW].includes(current.status)) return null;
    const updated = this.store.updateSpec(spec.id, { phase: 'review', status: SPEC_STATUS.REVIEW, lastError: null }, {
      actorRole: 'orchestrator', eventType: 'review.started', details: {},
    });
    const key = activeKey(spec.id, 'reviewer', 'review');
    if (this.active.has(key)) return this.active.get(key).handle;
    const registration = this.toolServer.register({ specId: spec.id, taskId: null, role: 'reviewer', phase: 'review' });
    const reviewWorkspace = this.workspaceManager.createReviewSnapshot(project, updated);
    const reviewSnapshot = reviewWorkspace.snapshot;
    const reviewScratch = reviewWorkspace.scratch;
    const diffFile = this.workspaceManager.reviewDiff(project, updated);
    const mediationNotes = this.store.listEvents(spec.id, 100)
      .filter((event) => event.eventType === 'dispute.resolved')
      .reverse()
      .map((event) => `${event.details.taskKey}: ${event.details.decision} — ${event.details.comments || 'no comments'}`);
    const prompt = reviewPrompt({
      spec: updated,
      project: { ...project, rootDir: reviewSnapshot },
      tasks: this.store.listTasks(spec.id),
      toolScript: this.toolScript,
      artifactPaths: this.artifactPaths(project, updated).map((file) => path.join(reviewSnapshot, path.relative(project.rootDir, file))),
      diffFile,
      scratchDir: reviewScratch,
      mediationNotes,
    });
    const handle = this.harnessRuntime.start({
      guildId: spec.guildId,
      threadId: spec.threadId,
      role: 'reviewer',
      cwd: reviewSnapshot,
      goalId: spec.id,
      taskId: 'spec-review',
      title: `사양 검토 · ${spec.slug}`,
      branch: this.workspaceManager.integrationBranch(updated),
      initialPrompt: prompt,
      extraEnvironment: { ...registration.environment, CLCODEX_SCRATCH_DIR: reviewScratch },
      onExit: (event) => {
        this.active.delete(key);
        this.toolServer.revoke(registration.token);
        const latest = this.store.requireSpec(spec.id);
        if (latest.status === SPEC_STATUS.REVIEW) {
          const reason = event.exitCode === 0
            ? 'Reviewer exited without review.verdict'
            : `Reviewer exited with ${event.exitCode}`;
          this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: reason }, {
            actorRole: 'reviewer',
            eventType: 'review.interrupted',
            details: { exitCode: event.exitCode, structuredCompletion: false },
          });
        }
      },
    });
    this.active.set(key, { handle, token: registration.token });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id));
    return handle;
  }

  async reviewVerdict(context, payload) {
    if (context.role !== 'reviewer') throw new Error('Only the reviewer can submit a review verdict');
    const { spec, project } = this.projectAndSpec(context.specId);
    if (spec.status !== SPEC_STATUS.REVIEW) throw new Error('Spec is not in review');
    const verdict = String(payload.verdict || '').toLowerCase();
    const comments = String(payload.comments || '').trim();
    const taskIds = Array.isArray(payload.taskIds) ? payload.taskIds : [];
    this.store.appendEvent({
      specId: spec.id,
      actorRole: 'reviewer',
      eventType: 'review.verdict',
      details: { verdict, comments, taskIds },
    });
    if (verdict === 'approve') {
      const beforeMerge = this.store.updateSpec(spec.id, { status: SPEC_STATUS.REVIEW, lastError: null });
      this.repository.writeWorkflow(project, beforeMerge, this.store.listTasks(spec.id));
      this.workspaceManager.syncControlDocs(project, beforeMerge);
      const mergeCommit = this.workspaceManager.finalizeSpec(project, beforeMerge);
      const completed = this.store.updateSpec(spec.id, { phase: 'completed', status: SPEC_STATUS.COMPLETED, lastError: null }, {
        actorRole: 'orchestrator', eventType: 'spec.completed', details: { mergeCommit, comments },
      });
      this.repository.writeWorkflow(project, completed, this.store.listTasks(spec.id));
      const commitSha = this.workspaceManager.commitControlDocs(project, completed);
      this.store.appendEvent({
        specId: spec.id,
        actorRole: 'orchestrator',
        eventType: 'spec.finalized',
        details: { mergeCommit, commitSha },
      });
      this.finishActive(spec.id, 'reviewer', 'review', { summary: comments || '사양 충족 승인', commitSha });
      await this.postOrchestrator(spec.threadId, {
        title: `사양 구현 완료 · ${spec.slug}`,
        description: comments || '리뷰 승인 및 main 통합 완료',
        fields: [
          { name: 'Merge commit', value: `\`${mergeCommit}\``, inline: true },
          { name: '최종 문서 commit', value: `\`${commitSha}\``, inline: true },
        ],
      });
      return { verdict, commitSha, mergeCommit, status: completed.status };
    }
    if (verdict === 'rework') {
      if (!taskIds.length) throw new Error('Rework verdict requires task IDs');
      for (const taskId of taskIds) this.store.resetTaskForRework(spec.id, taskId, comments, 'reviewer');
      const running = this.store.updateSpec(spec.id, { phase: 'execution', status: SPEC_STATUS.RUNNING, lastError: null }, {
        actorRole: 'orchestrator', eventType: 'review.rework_routed', details: { taskIds, comments },
      });
      this.finishActive(spec.id, 'reviewer', 'review', { summary: `재작업 요청: ${taskIds.join(', ')}` });
      this.repository.writeWorkflow(project, running, this.store.listTasks(spec.id));
      await this.dispatchReady(spec.id);
      return { verdict, taskIds, status: running.status };
    }
    if (verdict === 'blocked') {
      const blocked = this.store.updateSpec(spec.id, { status: SPEC_STATUS.BLOCKED, lastError: comments || 'Reviewer blocked the spec' });
      this.finishActive(spec.id, 'reviewer', 'review', { summary: comments || '검토 중단' }, true);
      this.repository.writeWorkflow(project, blocked, this.store.listTasks(spec.id));
      return { verdict, status: blocked.status };
    }
    throw new Error(`Invalid review verdict: ${verdict}`);
  }

  async raiseDispute(context, payload) {
    if (!['backend', 'frontend'].includes(context.role)) throw new Error('Only coders can raise a review dispute');
    const { spec, project } = this.projectAndSpec(context.specId);
    const task = this.store.requireTask(spec.id, context.taskId);
    if (task.role !== context.role || task.status !== TASK_STATUS.RUNNING) {
      throw new Error('Dispute token does not match a running assigned task');
    }
    if (!task.description.includes('Reviewer rework request:')) {
      throw new Error('A dispute may be raised only for reviewer-requested rework');
    }
    const reason = String(payload.reason || '').trim();
    const evidence = String(payload.evidence || '').trim();
    if (!reason) throw new Error('Dispute reason is required');
    const priorDecision = this.store.listEvents(spec.id, 300)
      .find((event) => event.taskId === task.id && event.eventType === 'dispute.resolved');
    if (priorDecision && !evidence) {
      throw new Error('This task already has a binding mediation decision; new objective evidence is required to reopen it');
    }
    this.store.updateTask(spec.id, task.id, {
      status: TASK_STATUS.BLOCKED,
      sessionId: null,
      lastError: `Review dispute: ${reason}`,
    }, {
      actorRole: context.role,
      eventType: 'dispute.raised',
      details: { taskKey: task.taskKey, reason, evidence, reopened: Boolean(priorDecision) },
    });
    const mediating = this.store.updateSpec(spec.id, {
      phase: 'mediation',
      status: SPEC_STATUS.MEDIATING,
      lastError: `DISPUTE:${task.taskKey}:${reason}`,
    }, {
      actorRole: 'orchestrator',
      eventType: 'dispute.mediation_started',
      details: { taskKey: task.taskKey, reason, automatic: true },
    });
    this.repository.writeWorkflow(project, mediating, this.store.listTasks(spec.id));
    this.finishActive(spec.id, task.role, task.id, { summary: `리뷰 이의 제기 · 자동 중재 이관: ${reason}` }, true);
    await this.postOrchestrator(spec.threadId, {
      title: '리뷰 이의 제기 · 자동 중재 시작',
      description: reason,
      fields: [
        { name: 'Spec', value: `\`${spec.id}\``, inline: true },
        { name: 'Task', value: `\`${task.taskKey}\``, inline: true },
        { name: '처리', value: '오케스트레이터가 승인 사양·diff·양측 근거를 읽고 구조화 판정을 제출합니다.' },
      ],
    });
    this.startMediation(spec.id, task.id);
    return { status: mediating.status, taskId: task.taskKey, automatic: true };
  }

  startMediation(specId, taskIdOrKey) {
    const { spec, project } = this.projectAndSpec(specId);
    const task = this.store.requireTask(spec.id, taskIdOrKey);
    if (![SPEC_STATUS.MEDIATING, SPEC_STATUS.BLOCKED].includes(spec.status)) {
      throw new Error(`Spec is not awaiting mediation: ${spec.status}`);
    }
    if (task.status !== TASK_STATUS.BLOCKED || !String(spec.lastError || '').includes(`DISPUTE:${task.taskKey}:`)) {
      throw new Error('The selected task is not an unresolved review dispute');
    }
    const keyTaskId = `mediation:${task.id}`;
    const key = activeKey(spec.id, 'orchestrator', keyTaskId);
    if (this.active.has(key)) return this.active.get(key).handle;

    const mediation = this.workspaceManager.createMediationSnapshot(project, spec, task);
    const registration = this.toolServer.register({
      specId: spec.id,
      taskId: task.id,
      taskKey: task.taskKey,
      role: 'orchestrator',
      phase: 'mediation',
    });
    const events = this.store.listEvents(spec.id, 300);
    const dispute = events.find((event) => event.taskId === task.id && event.eventType === 'dispute.raised');
    const review = events.find((event) => event.eventType === 'review.verdict'
      && Array.isArray(event.details.taskIds)
      && event.details.taskIds.some((id) => id === task.id || id === task.taskKey));
    const priorDecisions = events
      .filter((event) => event.taskId === task.id && event.eventType === 'dispute.resolved')
      .reverse()
      .map((event) => `${event.details.decision}: ${event.details.comments || event.details.rationale || 'no rationale'}`);
    const diffFile = mediation.diffFile;
    const prompt = mediationPrompt({
      spec,
      task,
      project: { ...project, rootDir: mediation.snapshot },
      toolScript: this.toolScript,
      artifactPaths: this.artifactPaths(project, spec)
        .map((file) => path.join(mediation.snapshot, path.relative(project.rootDir, file))),
      reviewComments: review?.details?.comments || task.description.split('Reviewer rework request:').at(-1)?.trim(),
      disputeReason: dispute?.details?.reason || task.lastError || spec.lastError,
      disputeEvidence: dispute?.details?.evidence || '',
      priorDecisions,
      diffFile,
      scratchDir: mediation.scratch,
    });
    const updated = spec.status === SPEC_STATUS.MEDIATING
      ? spec
      : this.store.updateSpec(spec.id, { phase: 'mediation', status: SPEC_STATUS.MEDIATING }, {
          actorRole: 'orchestrator', eventType: 'dispute.mediation_resumed', details: { taskKey: task.taskKey },
        });
    const handle = this.harnessRuntime.start({
      guildId: spec.guildId,
      threadId: spec.threadId,
      role: 'orchestrator',
      cwd: mediation.snapshot,
      goalId: spec.id,
      taskId: `mediate-${task.taskKey}`,
      title: `자동 중재 · ${task.taskKey}`,
      initialPrompt: prompt,
      extraEnvironment: { ...registration.environment, CLCODEX_SCRATCH_DIR: mediation.scratch },
      onExit: (event) => {
        this.active.delete(key);
        this.toolServer.revoke(registration.token);
        const latest = this.store.requireSpec(spec.id);
        if (latest.status === SPEC_STATUS.MEDIATING) {
          const reason = event.exitCode === 0
            ? 'Mediation process exited without dispute.resolve'
            : `Mediation process exited with ${event.exitCode}`;
          const interrupted = this.store.updateSpec(spec.id, {
            status: SPEC_STATUS.MEDIATING,
            lastError: `DISPUTE:${task.taskKey}:${reason}`,
          }, {
            actorRole: 'orchestrator', eventType: 'dispute.mediation_interrupted',
            details: { taskKey: task.taskKey, exitCode: event.exitCode, structuredCompletion: false },
          });
          this.repository.writeWorkflow(project, interrupted, this.store.listTasks(spec.id));
        }
      },
    });
    this.active.set(key, { handle, token: registration.token });
    this.repository.writeWorkflow(project, updated, this.store.listTasks(spec.id));
    return handle;
  }

  async resolveDispute(context, payload) {
    if (context.role !== 'orchestrator' || context.phase !== 'mediation') {
      throw new Error('Only the orchestrator mediation session can resolve a dispute');
    }
    const decision = String(payload.decision || '').trim().toLowerCase();
    const rationale = String(payload.rationale || payload.comments || '').trim();
    return this.applyMediationDecision(context.specId, context.taskId, decision, rationale, 'automatic-orchestrator', true);
  }

  async mediateDispute(specId, taskIdOrKey, decision, comments, actorId) {
    return this.applyMediationDecision(specId, taskIdOrKey, decision, comments, actorId, false);
  }

  async applyMediationDecision(specId, taskIdOrKey, decision, comments, actorId, automatic) {
    const { spec, project } = this.projectAndSpec(specId);
    const task = this.store.requireTask(spec.id, taskIdOrKey);
    if (![SPEC_STATUS.MEDIATING, SPEC_STATUS.BLOCKED].includes(spec.status) || task.status !== TASK_STATUS.BLOCKED) {
      throw new Error('The selected task is not awaiting dispute mediation');
    }
    if (!String(spec.lastError || '').startsWith(`DISPUTE:${task.taskKey}:`)) {
      throw new Error('The selected blocked task is not a review dispute');
    }
    if (!['reviewer', 'coder'].includes(decision)) throw new Error('Mediation decision must be reviewer or coder');
    const rationale = String(comments || '').trim();
    if (!rationale) throw new Error('Mediation rationale is required');
    this.store.appendEvent({
      specId: spec.id,
      taskId: task.id,
      actorRole: 'orchestrator',
      actorId,
      eventType: 'dispute.resolved',
      details: { taskKey: task.taskKey, decision, comments: rationale, automatic },
    });
    this.finishActive(spec.id, 'orchestrator', `mediation:${task.id}`, {
      summary: `중재 판정: ${decision} · ${rationale}`,
    });

    if (decision === 'reviewer') {
      const updatedTask = this.store.updateTask(spec.id, task.id, {
        status: TASK_STATUS.QUEUED,
        sessionId: null,
        lastError: null,
        description: `${task.description}\n\nOrchestrator binding mediation — reviewer position upheld:\n${rationale}`,
      }, {
        actorRole: 'orchestrator', actorId, eventType: 'dispute.rework_resumed',
        details: { taskKey: task.taskKey, decision, comments: rationale, automatic },
      });
      const running = this.store.updateSpec(spec.id, {
        phase: 'execution',
        status: SPEC_STATUS.RUNNING,
        lastError: null,
      });
      this.repository.writeWorkflow(project, running, this.store.listTasks(spec.id), actorId);
      await this.postOrchestrator(spec.threadId, {
        title: `자동 중재 완료 · reviewer 판정`,
        description: rationale,
        fields: [{ name: 'Task', value: `\`${task.taskKey}\`` }, { name: '후속 처리', value: `${task.role} 코더에게 기존 worktree로 자동 재배정` }],
      });
      this.startTask(spec.id, updatedTask.id, {
        reuseWorktree: Boolean(updatedTask.worktreeDir && updatedTask.branch && existsSync(updatedTask.worktreeDir)),
      });
      return running;
    }

    this.workspaceManager.removeTaskWorktree(project, task);
    const priorMerge = this.store.listEvents(spec.id, 500)
      .find((event) => event.taskId === task.id && event.eventType === 'task.merged');
    const acceptedCommit = priorMerge?.details?.commitSha || this.workspaceManager.integrationHead(project, spec);
    this.store.updateTask(spec.id, task.id, {
      status: TASK_STATUS.MERGED,
      worktreeDir: null,
      branch: null,
      commitSha: acceptedCommit,
      sessionId: null,
      lastError: null,
    }, {
      actorRole: 'orchestrator', actorId, eventType: 'dispute.coder_position_upheld',
      details: { taskKey: task.taskKey, decision, comments: rationale, acceptedCommit, automatic },
    });
    const running = this.store.updateSpec(spec.id, {
      phase: 'execution',
      status: SPEC_STATUS.RUNNING,
      lastError: null,
    });
    this.repository.writeWorkflow(project, running, this.store.listTasks(spec.id), actorId);
    await this.postOrchestrator(spec.threadId, {
      title: `자동 중재 완료 · coder 판정`,
      description: rationale,
      fields: [{ name: 'Task', value: `\`${task.taskKey}\`` }, { name: '후속 처리', value: '재작업 worktree 폐기 후 reviewer를 자동 재호출' }],
    });
    await this.dispatchReady(spec.id);
    return this.store.requireSpec(spec.id);
  }

  async resume({ guildId, threadId, actorId }) {
    const spec = this.store.currentSpecForThread(guildId, threadId);
    if (!spec) throw new Error('Resumable spec not found');
    if (spec.status === SPEC_STATUS.PLANNING) {
      this.startPlanning(spec.id);
    } else if (spec.status === SPEC_STATUS.RUNNING) {
      const running = this.store.runningTasks(spec.id);
      for (const task of running) this.startTask(spec.id, task.id, { reuseWorktree: true });
      await this.dispatchReady(spec.id);
    } else if (spec.status === SPEC_STATUS.REVIEW) {
      await this.startReview(spec.id);
    } else if (spec.status === SPEC_STATUS.MEDIATING) {
      const disputed = this.store.listTasks(spec.id).find((item) => item.status === TASK_STATUS.BLOCKED && String(spec.lastError || '').startsWith(`DISPUTE:${item.taskKey}:`));
      if (!disputed) throw new Error('Mediating spec has no unresolved dispute task');
      this.startMediation(spec.id, disputed.id);
    } else if (spec.status === SPEC_STATUS.BLOCKED) {
      if (String(spec.lastError || '').startsWith('DISPUTE:')) {
        const disputed = this.store.listTasks(spec.id).find((item) => item.status === TASK_STATUS.BLOCKED && String(spec.lastError || '').startsWith(`DISPUTE:${item.taskKey}:`));
        if (!disputed) throw new Error('Blocked spec has no unresolved dispute task');
        this.startMediation(spec.id, disputed.id);
        return this.store.requireSpec(spec.id);
      }
      if (['requirements', 'bugfix', 'design', 'tasks', 'quick-plan'].includes(spec.phase)) {
        const updated = this.store.updateSpec(spec.id, { status: SPEC_STATUS.PLANNING, lastError: null }, {
          actorRole: 'orchestrator', actorId, eventType: 'planning.resumed', details: { phase: spec.phase },
        });
        this.startPlanning(updated.id);
      } else if (spec.phase === 'review') {
        const updated = this.store.updateSpec(spec.id, { status: SPEC_STATUS.REVIEW, lastError: null }, {
          actorRole: 'orchestrator', actorId, eventType: 'review.resumed', details: {},
        });
        await this.startReview(updated.id);
      } else {
        const tasks = this.store.listTasks(spec.id);
        const blockedTasks = tasks.filter((item) => item.status === TASK_STATUS.BLOCKED);
        const updated = this.store.updateSpec(spec.id, { phase: 'execution', status: SPEC_STATUS.RUNNING, lastError: null }, {
          actorRole: 'orchestrator', actorId, eventType: 'execution.resumed', details: { tasks: blockedTasks.map((item) => item.taskKey) },
        });
        for (const task of blockedTasks) {
          this.store.updateTask(spec.id, task.id, { status: TASK_STATUS.QUEUED, lastError: null, sessionId: null });
          if (task.worktreeDir && task.branch && existsSync(task.worktreeDir)) {
            this.startTask(spec.id, task.id, { reuseWorktree: true });
          }
        }
        await this.dispatchReady(updated.id);
      }
    }
    return this.store.requireSpec(spec.id);
  }

  cancel(specId, actorId) {
    const { spec, project } = this.projectAndSpec(specId);
    for (const [key, session] of this.active) {
      if (!key.startsWith(`${spec.id}:`)) continue;
      session.handle.interrupt();
      session.handle.dispose();
      this.toolServer.revoke(session.token);
      this.active.delete(key);
    }
    for (const task of this.store.listTasks(spec.id)) {
      if (![TASK_STATUS.MERGED, TASK_STATUS.CANCELLED].includes(task.status)) {
        this.store.updateTask(spec.id, task.id, { status: TASK_STATUS.CANCELLED, sessionId: null });
      }
    }
    const cancelled = this.store.updateSpec(spec.id, { status: SPEC_STATUS.CANCELLED, lastError: null }, {
      actorRole: 'orchestrator', actorId, eventType: 'spec.cancelled', details: {},
    });
    this.repository.writeWorkflow(project, cancelled, this.store.listTasks(spec.id), actorId);
    return cancelled;
  }

  status(specId) {
    const { spec, project } = this.projectAndSpec(specId);
    return {
      spec,
      project,
      artifacts: this.store.listArtifacts(spec.id),
      tasks: this.store.listTasks(spec.id),
      events: this.store.listEvents(spec.id, 10),
      orchestration: this.policyStore?.resolvePolicy(spec.guildId, spec.threadId) || null,
    };
  }

  waveFields(tasks) {
    const waves = new Map();
    for (const task of tasks) {
      if (!waves.has(task.wave)) waves.set(task.wave, []);
      waves.get(task.wave).push(task);
    }
    return [...waves.entries()].slice(0, 5).map(([wave, items]) => ({
      name: `Wave ${wave}`,
      value: items.map((item) => `\`${item.taskKey}\` · ${item.role}`).join('\n').slice(0, 1024),
    }));
  }

  async postOrchestrator(channelId, embed) {
    if (!this.roleBots || !channelId) return;
    try {
      await this.roleBots.send('orchestrator', channelId, {
        embeds: [{ color: 0x7c3aed, timestamp: new Date().toISOString(), ...embed }],
      });
    } catch (error) {
      console.error('Failed to post orchestrator spec update:', error instanceof Error ? error.message : String(error));
    }
  }

  async close() {
    for (const session of this.active.values()) session.handle.dispose();
    this.active.clear();
    await Promise.allSettled(this.integrationQueues.values());
    this.integrationQueues.clear();
    await this.toolServer.close();
  }
}

export const __test = { slugify, activeKey };
