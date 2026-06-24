import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const DEFAULT_TASK_COMMAND_PREFIXES = Object.freeze([
  'npm test',
  'npm run',
  'pnpm test',
  'pnpm run',
  'pnpm exec vitest',
  'yarn test',
  'yarn run',
  'bun test',
  'bun run',
  'bunx vitest',
  'node --test',
  'npx vitest',
  'pytest',
  'python -m pytest',
  'python3 -m pytest',
  'cargo test',
  'go test',
  'dotnet test',
  'mvn test',
  'mvn verify',
  'gradle test',
  './gradlew test',
  'make test',
  'make check',
]);

const VERIFICATION_ENV_ALLOWLIST = Object.freeze([
  'PATH',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
]);

function parseCommandLine(command) {
  const source = String(command || '').trim();
  if (!source) throw new Error('Verification command cannot be empty');
  if (source.length > 2_000) throw new Error('Verification command is too long');
  if (/[\0\r\n]/.test(source)) throw new Error('Verification command contains a forbidden control character');

  const tokens = [];
  let token = '';
  let quote = null;
  let escaped = false;
  const push = () => {
    if (token.length) tokens.push(token);
    token = '';
  };

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      token += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== "'") {
      const next = source[index + 1];
      if (next && (/\s/.test(next) || ['\\', '"', "'"].includes(next))) {
        escaped = true;
      } else {
        token += character;
      }
      continue;
    }
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      push();
      continue;
    }
    if (';&|<>`$'.includes(character)) {
      throw new Error(`Verification command contains a forbidden shell operator: ${character}`);
    }
    token += character;
  }

  if (escaped) throw new Error('Verification command ends with an incomplete escape');
  if (quote) throw new Error('Verification command contains an unterminated quote');
  push();
  if (!tokens.length) throw new Error('Verification command cannot be empty');
  return tokens;
}

function commandMatchesPrefix(tokens, prefix) {
  const expected = parseCommandLine(prefix);
  if (tokens.length < expected.length) return false;
  return expected.every((value, index) => tokens[index] === value);
}

function assertTaskCommandAllowed(command, prefixes = DEFAULT_TASK_COMMAND_PREFIXES) {
  const tokens = parseCommandLine(command);
  const allowed = prefixes.some((prefix) => commandMatchesPrefix(tokens, prefix));
  if (!allowed) {
    throw new Error(`Task verification command is not allowlisted: ${tokens.join(' ')}`);
  }
  return tokens;
}

function verificationEnvironment(runtimeRoot, parent = process.env) {
  const home = path.join(path.resolve(runtimeRoot), 'verification-home');
  const cache = path.join(home, '.cache');
  const config = path.join(home, '.config');
  const data = path.join(home, '.local', 'share');
  const temporary = path.join(home, 'tmp');
  for (const directory of [home, cache, config, data, temporary, path.join(home, '.npm'), path.join(home, '.cargo')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const env = {};
  for (const key of VERIFICATION_ENV_ALLOWLIST) {
    if (parent[key]) env[key] = parent[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CACHE_HOME = cache;
  env.XDG_CONFIG_HOME = config;
  env.XDG_DATA_HOME = data;
  env.TMPDIR = temporary;
  env.TMP = temporary;
  env.TEMP = temporary;
  env.CARGO_HOME = path.join(home, '.cargo');
  env.NPM_CONFIG_USERCONFIG = path.join(home, '.npmrc');
  env.PIP_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null';
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.CI = '1';
  env.NO_COLOR = '1';
  return env;
}

function windowsExecutable(executable) {
  if (process.platform !== 'win32') return executable;
  const commandFiles = new Set(['npm', 'npx', 'pnpm', 'yarn', 'bun', 'bunx']);
  return commandFiles.has(executable.toLowerCase()) ? `${executable}.cmd` : executable;
}

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...options.env },
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

function safeSegment(value) {
  const result = String(value || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!result) throw new Error('Unsafe empty path segment');
  return result.slice(0, 80);
}

function globRegex(pattern) {
  const normalized = String(pattern).replace(/\\/g, '/').replace(/^\.\//, '');
  let output = '^';
  for (let index = 0; index < normalized.length; index += 1) {
    const character = normalized[index];
    if (character === '*') {
      if (normalized[index + 1] === '*') {
        index += 1;
        if (normalized[index + 1] === '/') {
          index += 1;
          output += '(?:.*/)?';
        } else output += '.*';
      } else output += '[^/]*';
    } else if (character === '?') output += '[^/]';
    else output += character.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
  }
  return new RegExp(`${output}$`);
}

function allowedFile(file, scopes) {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  return scopes.some((scope) => globRegex(scope).test(normalized));
}

function makeTreeWritable(target) {
  if (!existsSync(target) || process.platform === 'win32') return;
  const stat = statSync(target);
  if (stat.isDirectory()) {
    chmodSync(target, 0o700);
    for (const entry of readdirSync(target)) makeTreeWritable(path.join(target, entry));
  } else {
    chmodSync(target, 0o600);
  }
}

function protectReadOnlyTree(target, writableDirectories = new Set()) {
  if (process.platform === 'win32') return;
  const resolved = path.resolve(target);
  if (writableDirectories.has(resolved)) return;
  const stat = statSync(resolved);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(resolved)) protectReadOnlyTree(path.join(resolved, entry), writableDirectories);
    chmodSync(resolved, 0o500);
  } else {
    chmodSync(resolved, 0o400);
  }
}

export class GitWorkspaceManager {
  constructor({
    projectsRoot,
    runtimeRoot,
    verificationCommands = [],
    allowedTaskCommandPrefixes = DEFAULT_TASK_COMMAND_PREFIXES,
    autoPush = false,
  }) {
    this.projectsRoot = path.resolve(projectsRoot);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.verificationCommands = verificationCommands;
    this.allowedTaskCommandPrefixes = allowedTaskCommandPrefixes.length
      ? [...allowedTaskCommandPrefixes]
      : [...DEFAULT_TASK_COMMAND_PREFIXES];
    this.autoPush = autoPush;
    mkdirSync(this.projectsRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.runtimeRoot, { recursive: true, mode: 0o700 });
  }

  projectRoot(threadId, name) {
    return path.join(this.projectsRoot, `${safeSegment(name)}-${safeSegment(threadId).slice(-12)}`);
  }

  initializeProject({ threadId, name }) {
    const root = this.projectRoot(threadId, name);
    mkdirSync(root, { recursive: true, mode: 0o700 });
    if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') {
      git(root, ['init', '--initial-branch=main']);
      writeFileSync(path.join(root, 'README.md'), `# ${name}\n`, 'utf8');
      git(root, ['add', 'README.md']);
      git(root, ['-c', 'user.name=clcodex-integrator', '-c', 'user.email=integrator@localhost', 'commit', '-m', 'chore: initialize project']);
    }
    return root;
  }

  bindExisting(rootDir) {
    const root = path.resolve(rootDir);
    if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') throw new Error(`Not a Git worktree: ${root}`);
    return root;
  }

  assertClean(root) {
    const status = git(root, ['status', '--porcelain']);
    const nonControl = status.split('\n').filter(Boolean).filter((line) => !line.slice(3).replace(/\\/g, '/').startsWith('.clcodex/'));
    if (nonControl.length) throw new Error(`Project has unrelated local changes:\n${nonControl.join('\n')}`);
  }

  integrationBranch(spec) {
    return `clcodex/spec/${safeSegment(spec.slug)}`;
  }

  integrationWorktree(spec) {
    return path.join(this.runtimeRoot, 'integration', safeSegment(spec.id));
  }

  prepareSpec(project, spec) {
    this.assertClean(project.rootDir);
    const branch = this.integrationBranch(spec);
    const existing = tryGit(project.rootDir, ['show-ref', '--verify', `refs/heads/${branch}`]);
    if (!existing) git(project.rootDir, ['branch', branch, project.defaultBranch]);
    const worktree = this.integrationWorktree(spec);
    if (!existsSync(path.join(worktree, '.git'))) {
      rmSync(worktree, { recursive: true, force: true });
      mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
      git(project.rootDir, ['worktree', 'add', worktree, branch]);
    }
    this.syncControlDocs(project, spec);
    return { branch, worktree };
  }

  syncControlDocs(project, spec) {
    const worktree = this.integrationWorktree(spec);
    if (!existsSync(path.join(worktree, '.git'))) return null;
    const source = path.join(project.rootDir, '.clcodex');
    const target = path.join(worktree, '.clcodex');
    if (existsSync(source)) {
      rmSync(target, { recursive: true, force: true });
      cpSync(source, target, { recursive: true });
    }
    if (!existsSync(target)) return git(worktree, ['rev-parse', 'HEAD']);
    git(worktree, ['add', '.clcodex']);
    if (!git(worktree, ['status', '--porcelain'])) return git(worktree, ['rev-parse', 'HEAD']);
    git(worktree, [
      '-c', 'user.name=clcodex-orchestrator',
      '-c', 'user.email=orchestrator@localhost',
      'commit', '-m', `docs(spec): sync ${spec.slug} artifacts`,
    ]);
    return git(worktree, ['rev-parse', 'HEAD']);
  }

  createTaskWorktree(project, spec, task) {
    const integration = this.prepareSpec(project, spec);
    const attempt = task.attempts + 1;
    const branch = `agent/${safeSegment(spec.slug)}/${safeSegment(task.taskKey)}-r${attempt}`;
    const worktree = path.join(this.runtimeRoot, 'worktrees', safeSegment(spec.id), `${safeSegment(task.taskKey)}-r${attempt}`);
    rmSync(worktree, { recursive: true, force: true });
    mkdirSync(path.dirname(worktree), { recursive: true, mode: 0o700 });
    const existing = tryGit(project.rootDir, ['show-ref', '--verify', `refs/heads/${branch}`]);
    if (existing) git(project.rootDir, ['branch', '-D', branch]);
    git(project.rootDir, ['worktree', 'add', '-b', branch, worktree, integration.branch]);
    return { branch, worktree, baseCommit: git(worktree, ['rev-parse', 'HEAD']) };
  }

  taskChangedFiles(project, spec, task) {
    const branch = task.branch;
    if (!branch) throw new Error(`Task ${task.taskKey} has no branch`);
    const integration = this.integrationBranch(spec);
    const base = git(project.rootDir, ['merge-base', branch, integration]);
    const output = git(project.rootDir, ['diff', '--name-only', '--diff-filter=ACMR', `${base}..${branch}`]);
    return output.split('\n').map((item) => item.trim()).filter(Boolean);
  }

  finalizeTask(project, spec, task) {
    if (!task.worktreeDir || !task.branch) throw new Error(`Task ${task.taskKey} has no assigned worktree`);
    const status = git(task.worktreeDir, ['status', '--porcelain']);
    if (status) {
      git(task.worktreeDir, ['add', '-A']);
      git(task.worktreeDir, [
        '-c', 'user.name=clcodex-agent',
        '-c', 'user.email=agent@localhost',
        'commit', '-m', `task(${task.taskKey}): ${task.title}`,
      ]);
    }
    const commitSha = git(task.worktreeDir, ['rev-parse', 'HEAD']);
    const files = this.taskChangedFiles(project, spec, { ...task, commitSha });
    const forbidden = files.filter((file) => !allowedFile(file, task.fileScope));
    if (forbidden.length) {
      throw new Error(`Task ${task.taskKey} changed files outside its spec scope: ${forbidden.join(', ')}`);
    }
    for (const command of task.testCommands) this.runTaskCommand(task.worktreeDir, command);
    return { commitSha, files };
  }

  integrateTask(project, spec, task, commitSha) {
    const { worktree } = this.prepareSpec(project, spec);
    try {
      git(worktree, ['-c', 'user.name=clcodex-integrator', '-c', 'user.email=integrator@localhost', 'cherry-pick', commitSha]);
    } catch (error) {
      tryGit(worktree, ['cherry-pick', '--abort']);
      throw new Error(`Merge conflict while integrating ${task.taskKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return git(worktree, ['rev-parse', 'HEAD']);
  }


  integrationHead(project, spec) {
    const { worktree } = this.prepareSpec(project, spec);
    return git(worktree, ['rev-parse', 'HEAD']);
  }

  createPlanningSnapshot(project, spec) {
    const snapshotRoot = path.join(this.runtimeRoot, 'planning', safeSegment(spec.id));
    const snapshot = path.join(snapshotRoot, 'snapshot');
    const scratch = path.join(snapshotRoot, 'scratch');
    makeTreeWritable(snapshotRoot);
    rmSync(snapshotRoot, { recursive: true, force: true });
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    cpSync(project.rootDir, snapshot, {
      recursive: true,
      filter: (source) => {
        const name = path.basename(source);
        return !['.git', 'node_modules', '.runtime', '.harness', 'dist', 'coverage'].includes(name);
      },
    });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    protectReadOnlyTree(snapshot);
    return { snapshot, scratch };
  }

  createMediationSnapshot(project, spec, task) {
    const source = task.worktreeDir && existsSync(task.worktreeDir)
      ? task.worktreeDir
      : this.integrationWorktree(spec);
    if (!existsSync(source)) this.prepareSpec(project, spec);
    const root = path.join(this.runtimeRoot, 'mediations', safeSegment(spec.id), safeSegment(task.taskKey));
    const snapshot = path.join(root, 'snapshot');
    const scratch = path.join(root, 'scratch');
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    cpSync(source, snapshot, {
      recursive: true,
      filter: (entry) => !['.git', 'node_modules', '.runtime', '.harness', 'dist', 'coverage'].includes(path.basename(entry)),
    });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });

    const sections = [];
    if (task.worktreeDir && existsSync(task.worktreeDir) && task.branch) {
      const integration = this.integrationBranch(spec);
      const committed = tryGit(task.worktreeDir, ['diff', '--binary', `${integration}...HEAD`]);
      const working = tryGit(task.worktreeDir, ['diff', '--binary', 'HEAD']);
      const staged = tryGit(task.worktreeDir, ['diff', '--binary', '--cached']);
      const untracked = tryGit(task.worktreeDir, ['ls-files', '--others', '--exclude-standard']);
      sections.push(`# Task branch diff (${integration}...HEAD)
${committed || '(none)'}`);
      sections.push(`# Staged diff
${staged || '(none)'}`);
      sections.push(`# Working-tree diff
${working || '(none)'}`);
      sections.push(`# Untracked files
${untracked || '(none)'}`);
    } else {
      sections.push(`# Integration diff
${tryGit(this.integrationWorktree(spec), ['diff', '--binary', `${project.defaultBranch}...HEAD`]) || '(none)'}`);
    }
    const diffFile = path.join(root, `mediation-${Date.now()}.diff`);
    writeFileSync(diffFile, `${sections.join('\n\n')}\n`, { mode: 0o600 });
    protectReadOnlyTree(snapshot);
    return { snapshot, scratch, diffFile };
  }

  createReviewSnapshot(project, spec) {
    const { worktree } = this.prepareSpec(project, spec);
    const root = path.join(this.runtimeRoot, 'reviews', safeSegment(spec.id));
    const snapshot = path.join(root, 'snapshot');
    const scratch = path.join(root, 'scratch');
    makeTreeWritable(root);
    rmSync(root, { recursive: true, force: true });
    mkdirSync(snapshot, { recursive: true, mode: 0o700 });
    cpSync(worktree, snapshot, {
      recursive: true,
      filter: (source) => path.basename(source) !== '.git',
    });
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    protectReadOnlyTree(snapshot);
    return { snapshot, scratch };
  }

  reviewDiff(project, spec) {
    const { worktree, branch } = this.prepareSpec(project, spec);
    const diff = git(worktree, ['diff', '--binary', `${project.defaultBranch}...${branch}`]);
    const directory = path.join(this.runtimeRoot, 'reviews', safeSegment(spec.id));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, `review-${Date.now()}.diff`);
    writeFileSync(file, diff, { mode: 0o600 });
    return file;
  }

  finalizeSpec(project, spec) {
    const { worktree, branch } = this.prepareSpec(project, spec);
    for (const command of this.verificationCommands) this.runCommand(worktree, command);
    this.syncControlDocs(project, spec);
    const controlRoot = path.join(project.rootDir, '.clcodex');
    rmSync(controlRoot, { recursive: true, force: true });
    tryGit(project.rootDir, ['restore', '--source=HEAD', '--staged', '--worktree', '--', '.clcodex']);
    tryGit(project.rootDir, ['clean', '-fd', '--', '.clcodex']);
    this.assertClean(project.rootDir);
    const current = git(project.rootDir, ['branch', '--show-current']);
    if (current !== project.defaultBranch) git(project.rootDir, ['switch', project.defaultBranch]);
    git(project.rootDir, ['-c', 'user.name=clcodex-integrator', '-c', 'user.email=integrator@localhost', 'merge', '--no-ff', branch, '-m', `feat(spec): complete ${spec.slug}`], { env: { CLCODEX_INTEGRATOR: '1' } });
    if (this.autoPush && tryGit(project.rootDir, ['remote', 'get-url', 'origin'])) {
      git(project.rootDir, ['push', 'origin', project.defaultBranch], { env: { CLCODEX_INTEGRATOR: '1' } });
    }
    return git(project.rootDir, ['rev-parse', 'HEAD']);
  }

  commitControlDocs(project, spec) {
    git(project.rootDir, ['add', '.clcodex']);
    if (!git(project.rootDir, ['status', '--porcelain', '--', '.clcodex'])) {
      return git(project.rootDir, ['rev-parse', 'HEAD']);
    }
    git(project.rootDir, [
      '-c', 'user.name=clcodex-orchestrator',
      '-c', 'user.email=orchestrator@localhost',
      'commit', '-m', `docs(spec): finalize ${spec.slug} workflow`,
    ], { env: { CLCODEX_INTEGRATOR: '1' } });
    if (this.autoPush && tryGit(project.rootDir, ['remote', 'get-url', 'origin'])) {
      git(project.rootDir, ['push', 'origin', project.defaultBranch], { env: { CLCODEX_INTEGRATOR: '1' } });
    }
    return git(project.rootDir, ['rev-parse', 'HEAD']);
  }

  removeTaskWorktree(project, task) {
    if (!task.worktreeDir || !existsSync(task.worktreeDir)) return;
    tryGit(project.rootDir, ['worktree', 'remove', '--force', task.worktreeDir]);
  }

  deleteProject(rootDir) {
    const resolved = path.resolve(rootDir);
    const base = `${this.projectsRoot}${path.sep}`;
    if (!resolved.startsWith(base)) throw new Error('Refusing to delete a project outside PROJECTS_ROOT');
    rmSync(resolved, { recursive: true, force: true });
  }

  assertTaskCommands(tasks) {
    for (const task of tasks) {
      for (const command of task.testCommands || []) {
        assertTaskCommandAllowed(command, this.allowedTaskCommandPrefixes);
      }
    }
    return tasks;
  }

  runTaskCommand(cwd, command) {
    const tokens = assertTaskCommandAllowed(command, this.allowedTaskCommandPrefixes);
    return this.runTokens(cwd, tokens, command);
  }

  runCommand(cwd, command) {
    const tokens = parseCommandLine(command);
    return this.runTokens(cwd, tokens, command);
  }

  runTokens(cwd, tokens, displayCommand) {
    const [rawExecutable, ...args] = tokens;
    const executable = windowsExecutable(rawExecutable);
    const result = spawnSync(executable, args, {
      cwd,
      stdio: 'inherit',
      env: verificationEnvironment(this.runtimeRoot),
      shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`Verification command failed (${result.status}): ${displayCommand}`);
    }
  }
}

export const __test = {
  DEFAULT_TASK_COMMAND_PREFIXES,
  safeSegment,
  globRegex,
  allowedFile,
  parseCommandLine,
  assertTaskCommandAllowed,
  verificationEnvironment,
};
