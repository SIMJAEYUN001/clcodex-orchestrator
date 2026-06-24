import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const STEERING_TEMPLATES = Object.freeze({
  'product.md': `# Product steering\n\n## Purpose\n\n프로젝트 목적과 대상 사용자를 기록한다.\n\n## Core capabilities\n\n- 핵심 기능\n\n## Product constraints\n\n- 제품 제약\n`,
  'tech.md': `# Technical steering\n\n## Runtime and framework\n\n- runtime/framework/storage를 기록한다.\n\n## Quality gates\n\n- test, lint, build, deployment 규칙을 기록한다.\n\n## Non-functional requirements\n\n- 보안, 성능, 가용성 제약을 기록한다.\n`,
  'structure.md': `# Structure steering\n\n## Architecture boundaries\n\n- 디렉터리 ownership과 모듈 경계를 기록한다.\n\n## Naming\n\n- 이름·파일 배치 규칙을 기록한다.\n`,
  'role-policy.md': `# Role policy\n\n## Orchestrator\n\n사양·워크플로·중재 문서만 수정한다. 제품 코드를 수정하지 않는다.\n\n## Backend coder\n\n승인 task의 backend fileScope만 수정한다.\n\n## Frontend coder\n\n승인 task의 frontend fileScope만 수정한다.\n\n## Reviewer\n\n읽기 전용으로 diff와 사양을 검토한다.\n\n## Shared rule\n\n제품 코드, 주석, UI에 작업 과정·AI·구현 완료를 설명하는 메타 발언을 남기지 않는다.\n`,
});

function ensureDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
}

const ARTIFACT_FILE = Object.freeze({
  requirements: 'requirements.md',
  bugfix: 'bugfix.md',
  design: 'design.md',
  tasks: 'tasks.md',
  manifest: 'spec.json',
  workflow: 'workflow.md',
});

export class SpecRepository {
  constructor({ store }) {
    this.store = store;
  }

  controlRoot(project) {
    return path.join(project.rootDir, '.clcodex');
  }

  steeringRoot(project) {
    return path.join(this.controlRoot(project), 'steering');
  }

  specRoot(project, spec) {
    return path.join(this.controlRoot(project), 'specs', spec.slug);
  }

  initializeProject(project) {
    const root = this.steeringRoot(project);
    ensureDirectory(root);
    for (const [name, content] of Object.entries(STEERING_TEMPLATES)) {
      const file = path.join(root, name);
      if (!existsSync(file)) writeFileSync(file, content, { mode: 0o600 });
    }
    return root;
  }

  initializeSpec(project, spec) {
    this.initializeProject(project);
    ensureDirectory(this.specRoot(project, spec));
    this.writeWorkflow(project, spec, []);
  }

  steeringPaths(project) {
    return Object.keys(STEERING_TEMPLATES).map((name) => path.join(this.steeringRoot(project), name)).filter(existsSync);
  }

  artifactPath(project, spec, kind) {
    const name = ARTIFACT_FILE[kind];
    if (!name) throw new Error(`Unknown spec artifact: ${kind}`);
    return path.join(this.specRoot(project, spec), name);
  }

  artifactExists(project, spec, kind) {
    return existsSync(this.artifactPath(project, spec, kind));
  }

  readArtifact(project, spec, kind) {
    const file = this.artifactPath(project, spec, kind);
    if (!existsSync(file)) throw new Error(`Spec artifact is missing: ${kind}`);
    return readFileSync(file, 'utf8');
  }

  writeArtifact(project, spec, kind, content, actorId = 'orchestrator', status = 'draft') {
    const file = this.artifactPath(project, spec, kind);
    ensureDirectory(path.dirname(file));
    writeFileSync(file, String(content).replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n', { mode: 0o600 });
    const relativePath = path.relative(project.rootDir, file).replace(/\\/g, '/');
    this.store.setArtifactStatus(spec.id, kind, status, actorId, relativePath);
    return file;
  }

  writeTaskDocuments(project, spec, tasks, actorId = 'orchestrator') {
    const markdown = [
      `# Tasks · ${spec.slug}`,
      '',
      `목표: ${spec.objective}`,
      '',
      ...tasks.flatMap((task) => [
        `## ${task.taskKey} · ${task.title}`,
        '',
        `- 역할: \`${task.role}\``,
        `- Wave: ${task.wave}`,
        `- 의존성: ${task.dependencies.length ? task.dependencies.map((item) => `\`${item}\``).join(', ') : '없음'}`,
        `- 요구사항: ${task.requirementRefs.map((item) => `\`${item}\``).join(', ')}`,
        `- 파일 범위: ${task.fileScope.map((item) => `\`${item}\``).join(', ')}`,
        '',
        task.description,
        '',
        '### Acceptance criteria',
        ...task.acceptanceCriteria.map((item) => `- ${item}`),
        '',
        '### Verification',
        ...(task.testCommands.length ? task.testCommands.map((item) => `- \`${item}\``) : ['- 별도 task 명령 없음']),
        '',
      ]),
    ].join('\n');
    this.writeArtifact(project, spec, 'tasks', markdown, actorId, 'draft');
    const manifest = {
      version: 1,
      specId: spec.id,
      slug: spec.slug,
      revision: spec.revision,
      tasks: tasks.map((task) => ({
        id: task.taskKey,
        role: task.role,
        title: task.title,
        description: task.description,
        dependencies: task.dependencies,
        requirementRefs: task.requirementRefs,
        acceptanceCriteria: task.acceptanceCriteria,
        fileScope: task.fileScope,
        testCommands: task.testCommands,
        wave: task.wave,
      })),
    };
    this.writeArtifact(project, spec, 'manifest', JSON.stringify(manifest, null, 2), actorId, 'draft');
  }

  writeWorkflow(project, spec, tasks, actorId = 'orchestrator') {
    const events = this.store.listEvents(spec.id, 30).reverse();
    const lines = [
      `# Workflow · ${spec.slug}`,
      '',
      `- Spec ID: \`${spec.id}\``,
      `- Goal: ${spec.objective}`,
      `- Kind: \`${spec.kind}\``,
      `- Workflow: \`${spec.workflow}\``,
      `- Phase: \`${spec.phase}\``,
      `- Status: \`${spec.status}\``,
      `- Revision: ${spec.revision}`,
      `- Auto run: ${spec.autoRun ? 'yes' : 'no'}`,
      `- Last error: ${spec.lastError || 'none'}`,
      '',
      '## Task state',
      '',
      '| Task | Role | Wave | Status | Attempts | Commit |',
      '| --- | --- | ---: | --- | ---: | --- |',
      ...tasks.map((task) => `| ${task.taskKey} | ${task.role} | ${task.wave} | ${task.status} | ${task.attempts} | ${task.commitSha ? `\`${task.commitSha.slice(0, 12)}\`` : ''} |`),
      '',
      '## Recent transitions',
      '',
      ...(events.length ? events.map((item) => `- ${item.createdAt} · **${item.eventType}** · ${item.details.taskKey || item.taskId || ''} ${item.details.decision ? `· decision=${item.details.decision}` : ''}`.trim()) : ['- 없음']),
      '',
      '## Merge policy',
      '',
      '- 각 task는 전용 worktree/branch에서 실행한다.',
      '- merge queue는 single integrator가 직렬 처리한다.',
      '- reviewer는 읽기 전용 snapshot을 사용한다.',
      '- dispute.raise가 제출되면 오케스트레이터 중재 세션이 자동 실행되고 구조화 판정을 내린다.',
    ];
    const file = this.artifactPath(project, spec, 'workflow');
    ensureDirectory(path.dirname(file));
    writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
    this.store.setArtifactStatus(spec.id, 'workflow', 'active', actorId, path.relative(project.rootDir, file).replace(/\\/g, '/'));
    return file;
  }
}
