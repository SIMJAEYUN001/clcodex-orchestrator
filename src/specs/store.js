import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialPhase, SPEC_STATUS, TASK_STATUS } from './constants.js';

function now() {
  return new Date().toISOString();
}

function json(value, fallback) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

function project(row) {
  if (!row) return null;
  return {
    id: row.id,
    guildId: row.guild_id,
    threadId: row.thread_id,
    name: row.name,
    rootDir: row.root_dir,
    defaultBranch: row.default_branch,
    createdBy: row.created_by,
    createdAt: row.created_at,
    deletedAt: row.deleted_at,
  };
}

function spec(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    guildId: row.guild_id,
    threadId: row.thread_id,
    slug: row.slug,
    kind: row.kind,
    workflow: row.workflow,
    objective: row.objective,
    phase: row.phase,
    status: row.status,
    autoRun: row.auto_run === 1,
    revision: row.revision,
    approvedBy: row.approved_by,
    lastError: row.last_error,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function task(row) {
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    taskKey: row.task_key,
    role: row.role,
    title: row.title,
    description: row.description,
    dependencies: json(row.dependencies_json, []),
    requirementRefs: json(row.requirement_refs_json, []),
    acceptanceCriteria: json(row.acceptance_criteria_json, []),
    fileScope: json(row.file_scope_json, []),
    testCommands: json(row.test_commands_json, []),
    wave: row.wave,
    status: row.status,
    attempts: row.attempts,
    worktreeDir: row.worktree_dir,
    branch: row.branch,
    commitSha: row.commit_sha,
    sessionId: row.session_id,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    kind: row.kind,
    status: row.status,
    relativePath: row.relative_path,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function event(row) {
  if (!row) return null;
  return {
    id: row.id,
    specId: row.spec_id,
    taskId: row.task_id,
    actorRole: row.actor_role,
    actorId: row.actor_id,
    eventType: row.event_type,
    details: json(row.details_json, {}),
    createdAt: row.created_at,
  };
}

export class SpecStore {
  constructor(databasePath = ':memory:') {
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
    this.migrate();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS spec_projects (
        id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        name TEXT NOT NULL,
        root_dir TEXT NOT NULL,
        default_branch TEXT NOT NULL DEFAULT 'main',
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT,
        UNIQUE(guild_id,thread_id)
      );
      CREATE TABLE IF NOT EXISTS specs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES spec_projects(id),
        guild_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('feature','bugfix')),
        workflow TEXT NOT NULL CHECK(workflow IN ('requirements-first','design-first','quick-plan')),
        objective TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        auto_run INTEGER NOT NULL DEFAULT 0 CHECK(auto_run IN (0,1)),
        revision INTEGER NOT NULL DEFAULT 1,
        approved_by TEXT,
        last_error TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(project_id,slug)
      );
      CREATE TABLE IF NOT EXISTS spec_artifacts (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(spec_id,kind)
      );
      CREATE TABLE IF NOT EXISTS spec_tasks (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        task_key TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('backend','frontend')),
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        dependencies_json TEXT NOT NULL DEFAULT '[]',
        requirement_refs_json TEXT NOT NULL DEFAULT '[]',
        acceptance_criteria_json TEXT NOT NULL DEFAULT '[]',
        file_scope_json TEXT NOT NULL DEFAULT '[]',
        test_commands_json TEXT NOT NULL DEFAULT '[]',
        wave INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        worktree_dir TEXT,
        branch TEXT,
        commit_sha TEXT,
        session_id TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(spec_id,task_key)
      );
      CREATE TABLE IF NOT EXISTS spec_events (
        id TEXT PRIMARY KEY,
        spec_id TEXT NOT NULL REFERENCES specs(id) ON DELETE CASCADE,
        task_id TEXT,
        actor_role TEXT NOT NULL,
        actor_id TEXT,
        event_type TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_spec_project_thread ON spec_projects(guild_id,thread_id,deleted_at);
      CREATE INDEX IF NOT EXISTS idx_specs_thread ON specs(guild_id,thread_id,updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tasks_spec_status ON spec_tasks(spec_id,status,wave);
      CREATE INDEX IF NOT EXISTS idx_events_spec ON spec_events(spec_id,created_at DESC);
    `);
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createProject(input) {
    const id = randomUUID();
    const timestamp = now();
    this.db.prepare(`INSERT INTO spec_projects(id,guild_id,thread_id,name,root_dir,default_branch,created_by,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      id, input.guildId, input.threadId, input.name, input.rootDir, input.defaultBranch || 'main', input.createdBy, timestamp,
    );
    return this.requireProject(id);
  }

  projectForThread(guildId, threadId) {
    return project(this.db.prepare(`SELECT * FROM spec_projects WHERE guild_id=? AND thread_id=? AND deleted_at IS NULL`).get(guildId, threadId));
  }

  requireProject(id) {
    const value = project(this.db.prepare('SELECT * FROM spec_projects WHERE id=? AND deleted_at IS NULL').get(id));
    if (!value) throw new Error('Spec project not found');
    return value;
  }

  deleteProject(id, actorId) {
    const value = this.requireProject(id);
    const timestamp = now();
    this.transaction(() => {
      this.db.prepare('UPDATE spec_projects SET deleted_at=? WHERE id=?').run(timestamp, id);
      this.db.prepare(`UPDATE specs SET status=?,updated_at=? WHERE project_id=? AND status NOT IN (?,?)`)
        .run(SPEC_STATUS.CANCELLED, timestamp, id, SPEC_STATUS.COMPLETED, SPEC_STATUS.CANCELLED);
      this.appendEvent({
        specId: this.db.prepare('SELECT id FROM specs WHERE project_id=? ORDER BY updated_at DESC LIMIT 1').get(id)?.id,
        actorRole: 'orchestrator', actorId, eventType: 'project.deleted', details: { projectId: id },
      }, { allowMissingSpec: true });
    });
    return value;
  }

  createSpec(input) {
    const id = randomUUID();
    const timestamp = now();
    const phase = initialPhase(input.kind, input.workflow);
    this.db.prepare(`INSERT INTO specs(
      id,project_id,guild_id,thread_id,slug,kind,workflow,objective,phase,status,auto_run,revision,created_by,created_at,updated_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)`).run(
      id, input.projectId, input.guildId, input.threadId, input.slug, input.kind, input.workflow,
      input.objective, phase, SPEC_STATUS.PLANNING, input.autoRun ? 1 : 0, input.createdBy, timestamp, timestamp,
    );
    this.appendEvent({ specId: id, actorRole: 'orchestrator', actorId: input.createdBy, eventType: 'spec.created', details: { phase, kind: input.kind, workflow: input.workflow } });
    return this.requireSpec(id);
  }

  requireSpec(id) {
    const value = spec(this.db.prepare('SELECT * FROM specs WHERE id=?').get(id));
    if (!value) throw new Error('Spec not found');
    return value;
  }

  currentSpecForThread(guildId, threadId) {
    return spec(this.db.prepare(`SELECT * FROM specs WHERE guild_id=? AND thread_id=? ORDER BY
      CASE WHEN status IN ('completed','cancelled') THEN 1 ELSE 0 END, updated_at DESC LIMIT 1`).get(guildId, threadId));
  }

  listSpecsForThread(guildId, threadId, limit = 20) {
    return this.db.prepare('SELECT * FROM specs WHERE guild_id=? AND thread_id=? ORDER BY created_at DESC LIMIT ?')
      .all(guildId, threadId, Math.max(1, Math.min(Number(limit) || 20, 200))).map(spec);
  }

  updateSpec(id, patch, eventInput = null) {
    const current = this.requireSpec(id);
    const next = {
      phase: patch.phase ?? current.phase,
      status: patch.status ?? current.status,
      autoRun: patch.autoRun ?? current.autoRun,
      revision: current.revision + (patch.bumpRevision ? 1 : 0),
      approvedBy: patch.approvedBy === undefined ? current.approvedBy : patch.approvedBy,
      lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
    };
    const timestamp = now();
    this.db.prepare(`UPDATE specs SET phase=?,status=?,auto_run=?,revision=?,approved_by=?,last_error=?,updated_at=? WHERE id=?`)
      .run(next.phase, next.status, next.autoRun ? 1 : 0, next.revision, next.approvedBy, next.lastError, timestamp, id);
    if (eventInput) this.appendEvent({ specId: id, ...eventInput });
    return this.requireSpec(id);
  }

  setArtifactStatus(specId, kind, status, actorId, relativePath = null) {
    const timestamp = now();
    const existing = this.db.prepare('SELECT * FROM spec_artifacts WHERE spec_id=? AND kind=?').get(specId, kind);
    if (existing) {
      this.db.prepare('UPDATE spec_artifacts SET status=?,relative_path=?,updated_by=?,updated_at=? WHERE spec_id=? AND kind=?')
        .run(status, relativePath || existing.relative_path, actorId || 'orchestrator', timestamp, specId, kind);
    } else {
      this.db.prepare(`INSERT INTO spec_artifacts(id,spec_id,kind,status,relative_path,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(randomUUID(), specId, kind, status, relativePath || `${kind}.md`, actorId || 'orchestrator', timestamp);
    }
    return artifact(this.db.prepare('SELECT * FROM spec_artifacts WHERE spec_id=? AND kind=?').get(specId, kind));
  }

  listArtifacts(specId) {
    return this.db.prepare('SELECT * FROM spec_artifacts WHERE spec_id=? ORDER BY updated_at').all(specId).map(artifact);
  }

  replaceTasks(specId, manifest, actorId) {
    const timestamp = now();
    return this.transaction(() => {
      this.db.prepare('DELETE FROM spec_tasks WHERE spec_id=?').run(specId);
      for (const item of manifest) {
        this.db.prepare(`INSERT INTO spec_tasks(
          id,spec_id,task_key,role,title,description,dependencies_json,requirement_refs_json,
          acceptance_criteria_json,file_scope_json,test_commands_json,wave,status,attempts,created_at,updated_at
        ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          randomUUID(), specId, item.taskKey, item.role, item.title, item.description,
          JSON.stringify(item.dependencies || []), JSON.stringify(item.requirementRefs || []),
          JSON.stringify(item.acceptanceCriteria || []), JSON.stringify(item.fileScope || []),
          JSON.stringify(item.testCommands || []), item.wave || 0, TASK_STATUS.QUEUED, 0, timestamp, timestamp,
        );
      }
      this.appendEvent({ specId, actorRole: 'orchestrator', actorId, eventType: 'tasks.replaced', details: { count: manifest.length } });
      return this.listTasks(specId);
    });
  }

  listTasks(specId) {
    return this.db.prepare('SELECT * FROM spec_tasks WHERE spec_id=? ORDER BY wave,task_key').all(specId).map(task);
  }

  requireTask(specId, idOrKey) {
    const value = task(this.db.prepare('SELECT * FROM spec_tasks WHERE spec_id=? AND (id=? OR task_key=?)').get(specId, idOrKey, idOrKey));
    if (!value) throw new Error(`Spec task not found: ${idOrKey}`);
    return value;
  }

  updateTask(specId, idOrKey, patch, eventInput = null) {
    const current = this.requireTask(specId, idOrKey);
    const next = {
      status: patch.status ?? current.status,
      description: patch.description ?? current.description,
      attempts: current.attempts + (patch.incrementAttempts ? 1 : 0),
      worktreeDir: patch.worktreeDir === undefined ? current.worktreeDir : patch.worktreeDir,
      branch: patch.branch === undefined ? current.branch : patch.branch,
      commitSha: patch.commitSha === undefined ? current.commitSha : patch.commitSha,
      sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
      lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
    };
    this.db.prepare(`UPDATE spec_tasks SET status=?,description=?,attempts=?,worktree_dir=?,branch=?,commit_sha=?,session_id=?,last_error=?,updated_at=? WHERE id=?`)
      .run(next.status, next.description, next.attempts, next.worktreeDir, next.branch, next.commitSha, next.sessionId, next.lastError, now(), current.id);
    if (eventInput) this.appendEvent({ specId, taskId: current.id, ...eventInput });
    return this.requireTask(specId, current.id);
  }

  resetTaskForRework(specId, idOrKey, comments, actorRole = 'reviewer') {
    const current = this.requireTask(specId, idOrKey);
    const description = `${current.description.replace(/\n\nReviewer rework request:[\s\S]*$/m, '')}\n\nReviewer rework request:\n${String(comments || '').trim()}`;
    return this.updateTask(specId, current.id, {
      status: TASK_STATUS.QUEUED,
      description,
      worktreeDir: null,
      branch: null,
      commitSha: null,
      sessionId: null,
      lastError: null,
    }, {
      actorRole,
      eventType: 'task.rework_queued',
      details: { taskKey: current.taskKey, comments: String(comments || '').trim() },
    });
  }

  readyTasks(specId) {
    const tasks = this.listTasks(specId);
    const merged = new Set(tasks.filter((item) => item.status === TASK_STATUS.MERGED).map((item) => item.taskKey));
    return tasks.filter((item) => item.status === TASK_STATUS.QUEUED && item.dependencies.every((dependency) => merged.has(dependency)));
  }

  runningTasks(specId) {
    return this.listTasks(specId).filter((item) => item.status === TASK_STATUS.RUNNING);
  }

  allTasksMerged(specId) {
    const tasks = this.listTasks(specId);
    return tasks.length > 0 && tasks.every((item) => item.status === TASK_STATUS.MERGED);
  }

  appendEvent(input, options = {}) {
    if (!input.specId) {
      if (options.allowMissingSpec) return null;
      throw new Error('specId is required for spec event');
    }
    const id = randomUUID();
    this.db.prepare(`INSERT INTO spec_events(id,spec_id,task_id,actor_role,actor_id,event_type,details_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      id, input.specId, input.taskId || null, input.actorRole || 'orchestrator', input.actorId || null,
      input.eventType, JSON.stringify(input.details || {}), now(),
    );
    return event(this.db.prepare('SELECT * FROM spec_events WHERE id=?').get(id));
  }

  listEvents(specId, limit = 100) {
    return this.db.prepare('SELECT * FROM spec_events WHERE spec_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?')
      .all(specId, Math.max(1, Math.min(Number(limit) || 100, 1000))).map(event);
  }

  close() {
    this.db.close();
  }
}
