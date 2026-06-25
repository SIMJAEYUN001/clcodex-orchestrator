import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 24_000;
const SAFE_ENV_KEYS = [
  'PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'TZ',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HOME', 'USERPROFILE', 'CODEX_HOME',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT',
];
const BLOCKED_ENV_KEYS = new Set([
  'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_API_KEY_HELPER', 'CLAUDE_CODE_API_KEY', 'CLAUDE_CONFIG_DIR',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_BASE_PATH', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID',
  'CLCODEX_GATEWAY_TOKEN', 'CLCODEX_PROVIDER_ID', 'CLCODEX_PROVIDER_REVISION', 'CLCODEX_SESSION_ID',
]);

export function harnessExecutable(harness, harnessRoot) {
  if (!['codex', 'claude'].includes(harness)) throw new Error('Harness must be codex or claude');
  if (!harnessRoot) return harness;
  return path.join(path.resolve(harnessRoot), 'bin', process.platform === 'win32' ? `${harness}.cmd` : harness);
}

export function cliOauthEnvironment(parentEnv = process.env) {
  const env = {};
  for (const key of SAFE_ENV_KEYS) if (parentEnv[key]) env[key] = parentEnv[key];
  for (const key of BLOCKED_ENV_KEYS) delete env[key];
  if (!env.HOME && os.homedir()) env.HOME = os.homedir();
  if (!env.USERPROFILE && env.HOME) env.USERPROFILE = env.HOME;
  if (!env.TERM) env.TERM = 'xterm-256color';
  return env;
}

function loginArgs(harness) {
  if (harness === 'codex') return ['login', '--device-auth'];
  if (harness === 'claude') return ['auth', 'login'];
  throw new Error('Harness must be codex or claude');
}

function statusArgs(harness) {
  if (harness === 'codex') return ['login', 'status'];
  if (harness === 'claude') return ['auth', 'status'];
  throw new Error('Harness must be codex or claude');
}

export function sanitizeCliOutput(value) {
  return String(value || '')
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, '[redacted-api-key]')
    .replace(/([A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{24,})/g, '[redacted-token]')
    .replace(/(access[_ -]?token\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/(api[_ -]?key\s*[:=]\s*)\S+/gi, '$1[redacted]');
}

function appendLimited(current, chunk) {
  const next = `${current}${sanitizeCliOutput(chunk)}`;
  return next.length > OUTPUT_LIMIT ? next.slice(next.length - OUTPUT_LIMIT) : next;
}

export class CliOauthManager {
  constructor({ harnessRoot = null, parentEnv = process.env, now = () => Date.now(), ttlMs = 15 * 60_000 } = {}) {
    this.harnessRoot = harnessRoot;
    this.parentEnv = parentEnv;
    this.now = now;
    this.ttlMs = ttlMs;
    this.sessions = new Map();
  }

  env() { return cliOauthEnvironment(this.parentEnv); }

  async status(harness) {
    const started = this.now();
    try {
      const { stdout, stderr } = await execFileAsync(harnessExecutable(harness, this.harnessRoot), statusArgs(harness), {
        env: this.env(),
        timeout: 10_000,
        maxBuffer: 200_000,
        shell: process.platform === 'win32',
      });
      const output = sanitizeCliOutput(`${stdout || ''}${stderr || ''}`).trim();
      const loggedIn = harness === 'codex'
        ? /logged in/i.test(output) && !/not logged in/i.test(output)
        : /"loggedIn"\s*:\s*true/i.test(output) || /logged in/i.test(output);
      return { ok: true, harness, loggedIn, exitCode: 0, output, latencyMs: this.now() - started };
    } catch (error) {
      const output = sanitizeCliOutput(`${error?.stdout || ''}${error?.stderr || ''}${error?.message || String(error)}`).trim();
      return { ok: true, harness, loggedIn: false, exitCode: Number.isInteger(error?.code) ? error.code : 1, output, latencyMs: this.now() - started };
    }
  }

  start(harness, { actorId = null } = {}) {
    for (const [id, session] of this.sessions) {
      if (session.harness === harness && session.status === 'running') return this.describe(id);
    }
    const id = randomUUID();
    const executable = harnessExecutable(harness, this.harnessRoot);
    const args = loginArgs(harness);
    const session = {
      id,
      harness,
      actorId,
      command: `${path.basename(executable)} ${args.join(' ')}`,
      startedAt: new Date(this.now()).toISOString(),
      updatedAt: new Date(this.now()).toISOString(),
      expiresAt: this.now() + this.ttlMs,
      status: 'running',
      exitCode: null,
      output: '',
      process: null,
    };
    const child = pty.spawn(executable, args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 28,
      cwd: os.homedir(),
      env: this.env(),
    });
    session.process = child;
    child.onData((data) => {
      session.output = appendLimited(session.output, data);
      session.updatedAt = new Date(this.now()).toISOString();
    });
    child.onExit(({ exitCode }) => {
      session.status = 'exited';
      session.exitCode = exitCode;
      session.updatedAt = new Date(this.now()).toISOString();
      session.expiresAt = this.now() + this.ttlMs;
    });
    this.sessions.set(id, session);
    return this.describe(id);
  }

  input(id, data) {
    const session = this.require(id);
    if (session.status !== 'running') throw new Error('CLI OAuth login session is not running');
    session.process.write(String(data || ''));
    session.updatedAt = new Date(this.now()).toISOString();
    return this.describe(id);
  }

  stop(id) {
    const session = this.require(id);
    if (session.status === 'running') {
      session.process.kill();
      session.status = 'stopped';
      session.updatedAt = new Date(this.now()).toISOString();
      session.expiresAt = this.now() + this.ttlMs;
    }
    return this.describe(id);
  }

  require(id) {
    this.sweep();
    const session = this.sessions.get(String(id || ''));
    if (!session) throw new Error('CLI OAuth login session is missing or expired');
    return session;
  }

  describe(id) {
    const session = this.require(id);
    return {
      id: session.id,
      harness: session.harness,
      command: session.command,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      status: session.status,
      exitCode: session.exitCode,
      output: session.output,
    };
  }

  list() {
    this.sweep();
    return [...this.sessions.keys()].map((id) => this.describe(id));
  }

  sweep() {
    const now = this.now();
    for (const [id, session] of this.sessions) {
      if (session.status === 'running') continue;
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  close() {
    for (const session of this.sessions.values()) {
      if (session.status === 'running') session.process.kill();
    }
    this.sessions.clear();
  }
}

export const __test = { loginArgs, statusArgs, appendLimited, BLOCKED_ENV_KEYS };
