import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { buildHarnessLaunch } from './providers/resolver.js';

export class ManagedHarnessRuntime {
  constructor({ resolver, runtimeRoot, harnessRoot, outputRouter = null }) {
    this.resolver = resolver;
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.harnessRoot = path.resolve(harnessRoot);
    this.outputRouter = outputRouter;
    this.sessions = new Map();
  }

  start({
    guildId,
    threadId,
    role,
    cwd,
    taskId,
    goalId,
    title,
    branch,
    onData,
    onExit,
  }) {
    const resolved = this.resolver.resolve({ guildId, threadId, role });
    if (!resolved) throw new Error(`No role-model binding for ${role}; run /role-models panel`);
    const id = randomUUID();
    const launch = buildHarnessLaunch({
      resolved,
      runtimeRoot: this.runtimeRoot,
      sessionId: id,
      cwd,
    });
    const executable = path.join(
      this.harnessRoot,
      'bin',
      process.platform === 'win32' ? `${launch.harness}.cmd` : launch.harness,
    );
    if (!existsSync(executable)) throw new Error(`Harness is not installed: ${executable}`);
    mkdirSync(cwd, { recursive: true, mode: 0o700 });

    const workLog = this.outputRouter && threadId
      ? this.outputRouter.createTaskStream({
        guildId,
        channelId: threadId,
        goalId,
        taskId,
        role,
        title: title || taskId || '할당 작업',
        branch,
        harness: resolved.profile.harness,
        providerId: resolved.profile.id,
        providerName: resolved.profile.name,
        providerRevision: launch.providerRevision,
        model: resolved.model,
      })
      : null;

    const terminal = pty.spawn(executable, launch.args, {
      name: 'xterm-256color',
      cols: 140,
      rows: 48,
      cwd,
      env: launch.env,
    });
    const handle = {
      id,
      taskId,
      goalId,
      role,
      providerId: resolved.profile.id,
      providerRevision: launch.providerRevision,
      model: resolved.model,
      input(text) {
        terminal.write(String(text).endsWith('\n') ? String(text) : `${text}\r`);
      },
      interrupt() {
        terminal.write('\x03');
      },
      resize(cols, rows) {
        terminal.resize(cols, rows);
      },
      dispose() {
        terminal.kill();
      },
      complete(details = {}) {
        return workLog?.finish(details);
      },
      fail(details = {}) {
        return workLog?.fail(details);
      },
    };
    terminal.onData((data) => {
      workLog?.write(data);
      onData?.(data, handle);
    });
    terminal.onExit((event) => {
      this.sessions.delete(id);
      if (event.exitCode === 0) {
        void workLog?.finish({ summary: `하네스 프로세스 종료 (exit ${event.exitCode})` });
      } else {
        void workLog?.fail({
          interrupted: event.signal != null,
          summary: `하네스 프로세스 종료 (exit ${event.exitCode}, signal ${event.signal ?? 'none'})`,
        });
      }
      onExit?.(event, handle);
    });
    this.sessions.set(id, handle);
    return handle;
  }
}
