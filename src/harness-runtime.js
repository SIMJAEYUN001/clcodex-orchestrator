import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import { buildHarnessLaunch } from './providers/resolver.js';

export class ManagedHarnessRuntime {
  constructor({ resolver, gateway, runtimeRoot, harnessRoot, outputRouter = null, policyStore = null }) {
    this.resolver = resolver;
    this.gateway = gateway;
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.harnessRoot = path.resolve(harnessRoot);
    this.outputRouter = outputRouter;
    this.policyStore = policyStore;
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
    initialPrompt,
    extraEnvironment = {},
    onData,
    onExit,
  }) {
    const resolved = this.resolver.resolve({ guildId, threadId, role });
    if (!resolved) throw new Error(`No role-model binding for ${role}; run /role-models panel`);
    const id = randomUUID();
    const gatewayRoute = resolved.profile.authType === 'oauth' ? null : this.gateway?.createRoute({
      profile: resolved.profile,
      credential: resolved.credential,
      sessionId: id,
    });
    const runtimePolicy = this.policyStore?.resolveRoleSettings(guildId, threadId, role) || { settings: null, scopeType: 'default', revision: 0 };
    const launch = buildHarnessLaunch({
      resolved,
      gatewayRoute,
      runtimeRoot: this.runtimeRoot,
      sessionId: id,
      cwd,
      runtimeSettings: runtimePolicy.settings,
    });
    for (const [key, value] of Object.entries(extraEnvironment || {})) {
      if (value != null) launch.env[key] = String(value);
    }
    const executable = path.join(
      this.harnessRoot,
      'bin',
      process.platform === 'win32' ? `${launch.harness}.cmd` : launch.harness,
    );
    if (!existsSync(executable)) {
      gatewayRoute?.revoke();
      throw new Error(`Harness is not installed: ${executable}`);
    }
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
        runtimePolicyScope: runtimePolicy.scopeType,
        runtimePolicyRevision: runtimePolicy.revision,
      })
      : null;

    const terminal = pty.spawn(executable, launch.args, {
      name: 'xterm-256color',
      cols: 140,
      rows: 48,
      cwd,
      env: launch.env,
    });
    let disposed = false;
    const revoke = () => gatewayRoute?.revoke();
    const handle = {
      id,
      taskId,
      goalId,
      role,
      providerId: resolved.profile.id,
      providerRevision: launch.providerRevision,
      model: resolved.model,
      harness: resolved.profile.harness,
      runtimePolicyScope: runtimePolicy.scopeType,
      runtimePolicyRevision: runtimePolicy.revision,
      runtimeSettings: launch.runtimeSettings,
      input(text) {
        terminal.write(String(text).endsWith('\n') ? String(text) : `${text}\r`);
      },
      interrupt() { terminal.write('\x03'); },
      resize(cols, rows) { terminal.resize(cols, rows); },
      dispose() {
        if (disposed) return;
        disposed = true;
        revoke();
        terminal.kill();
      },
      complete(details = {}) { return workLog?.finish(details); },
      fail(details = {}) { return workLog?.fail(details); },
    };
    terminal.onData((data) => {
      workLog?.write(data);
      onData?.(data, handle);
    });
    terminal.onExit((event) => {
      disposed = true;
      revoke();
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
    if (initialPrompt) {
      const timer = setTimeout(() => {
        if (!disposed) terminal.write(`${String(initialPrompt).replace(/\0/g, '').replace(/\r/g, '')}\r`);
      }, 250);
      timer.unref?.();
    }
    return handle;
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => ({
      id: session.id,
      taskId: session.taskId || null,
      goalId: session.goalId || null,
      role: session.role,
      harness: session.harness,
      providerId: session.providerId,
      providerRevision: session.providerRevision,
      model: session.model,
      runtimePolicyScope: session.runtimePolicyScope,
      runtimePolicyRevision: session.runtimePolicyRevision,
    }));
  }
}
