import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as pty from 'node-pty';
import type { AppConfig, HarnessProfile, Role } from './types.js';

const SAFE_PARENT_ENV = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'
] as const;

export interface SessionHandle {
  id: string;
  role: Role;
  taskId?: string;
  input(text: string): void;
  interrupt(): void;
  dispose(): void;
}

export class HarnessRuntime {
  readonly sessions = new Map<string, SessionHandle>();

  constructor(private readonly config: AppConfig) {}

  private profileRoot(role: Role): string {
    return path.join(this.config.harnessRoot, 'state', 'profiles', role);
  }

  private buildEnvironment(profile: HarnessProfile, sessionId: string): NodeJS.ProcessEnv {
    const root = this.profileRoot(profile.role);
    const home = path.join(root, 'home');
    const claudeConfig = path.join(root, 'claude-config');
    const codexHome = path.join(root, 'codex-home');
    const xdgConfig = path.join(root, 'xdg-config');
    const xdgCache = path.join(root, 'xdg-cache');
    const xdgData = path.join(root, 'xdg-data');
    for (const dir of [home, claudeConfig, codexHome, xdgConfig, xdgCache, xdgData]) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const env: NodeJS.ProcessEnv = {};
    for (const key of SAFE_PARENT_ENV) if (process.env[key]) env[key] = process.env[key];
    env.HOME = home;
    env.USERPROFILE = home;
    env.XDG_CONFIG_HOME = xdgConfig;
    env.XDG_CACHE_HOME = xdgCache;
    env.XDG_DATA_HOME = xdgData;
    env.CLAUDE_CONFIG_DIR = claudeConfig;
    env.CODEX_HOME = path.join(codexHome, sessionId);
    env.CLCODEX_ROLE = profile.role;
    env.CLCODEX_SESSION_ID = sessionId;
    env.CLCODEX_COMMAND_SOCKET = path.join(this.config.runtimeRoot, 'command-bus.sock');
    mkdirSync(env.CODEX_HOME, { recursive: true, mode: 0o700 });

    if (profile.authMode !== 'subscription') {
      const key = profile.apiKeyEnv ? process.env[profile.apiKeyEnv] : undefined;
      if (!key) throw new Error(`Missing credential environment variable ${profile.apiKeyEnv ?? '(unset)'}`);
      if (profile.harness === 'claude') {
        if (profile.authMode === 'proxy') env.ANTHROPIC_BASE_URL = profile.baseUrl;
        const helper = path.join(claudeConfig, `api-key-helper-${profile.role}.sh`);
        writeFileSync(helper, '#!/usr/bin/env sh\nprintf %s "$CLCODEX_PROFILE_API_KEY"\n', { mode: 0o700 });
        chmodSync(helper, 0o700);
        env.CLCODEX_PROFILE_API_KEY = key;
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_API_KEY;
        const settings = path.join(claudeConfig, 'settings.json');
        writeFileSync(settings, JSON.stringify({ apiKeyHelper: helper }, null, 2), { mode: 0o600 });
      } else {
        env.OPENAI_API_KEY = key;
        if (profile.authMode === 'proxy' && profile.baseUrl) env.OPENAI_BASE_URL = profile.baseUrl;
      }
    }
    return env;
  }

  start(role: Role, cwd: string, taskId?: string, onData?: (data: string) => void): SessionHandle {
    const profile = this.config.profiles[role];
    const id = randomUUID();
    const executable = path.join(this.config.harnessRoot, 'bin', profile.harness);
    if (!existsSync(executable)) throw new Error(`Harness is not installed: ${executable}`);
    const env = this.buildEnvironment(profile, id);
    const args = profile.model ? ['--model', profile.model] : [];
    const terminal = pty.spawn(executable, args, {
      name: 'xterm-256color', cols: 120, rows: 40, cwd, env: env as Record<string, string>
    });
    terminal.onData((chunk) => onData?.(chunk));
    terminal.onExit(() => this.sessions.delete(id));
    const handle: SessionHandle = {
      id, role, taskId,
      input: (text) => terminal.write(text.endsWith('\n') ? text : `${text}\r`),
      interrupt: () => terminal.write('\x03'),
      dispose: () => terminal.kill()
    };
    this.sessions.set(id, handle);
    return handle;
  }
}
