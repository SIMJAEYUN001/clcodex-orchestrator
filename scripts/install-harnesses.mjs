import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = path.join(root, '.harness');
const prefix = path.join(harnessRoot, 'packages');
const bin = path.join(harnessRoot, 'bin');

await mkdir(prefix, { recursive: true, mode: 0o700 });
await mkdir(bin, { recursive: true, mode: 0o700 });

const run = (command, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
});

await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
  'install', '--prefix', prefix, '--no-save', '--ignore-scripts=false',
  '@anthropic-ai/claude-code', '@openai/codex'
]);

const wrappers = {
  claude: path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'claude.cmd' : 'claude'),
  codex: path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? 'codex.cmd' : 'codex')
};

for (const [name, target] of Object.entries(wrappers)) {
  const file = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
  await rm(file, { force: true });
  const body = process.platform === 'win32'
    ? `@echo off\r\n"${target}" %*\r\n`
    : `#!/usr/bin/env sh\nexec "${target}" "$@"\n`;
  await writeFile(file, body, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(file, 0o700);
}

console.log(`Installed isolated harnesses under ${harnessRoot}`);
