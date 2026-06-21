import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const harnessRoot = path.join(root, '.harness');
const prefix = path.join(harnessRoot, 'packages');
const bin = path.join(harnessRoot, 'bin');
await mkdir(prefix, { recursive: true, mode: 0o700 });
await mkdir(bin, { recursive: true, mode: 0o700 });

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code ?? signal}`)));
  });
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
await run(npm, ['install', '--prefix', prefix, '--no-save', '@anthropic-ai/claude-code', '@openai/codex']);

for (const name of ['claude', 'codex']) {
  const target = path.join(prefix, 'node_modules', '.bin', process.platform === 'win32' ? `${name}.cmd` : name);
  const wrapper = path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name);
  await rm(wrapper, { force: true });
  const body = process.platform === 'win32'
    ? `@echo off\r\n"${target}" %*\r\n`
    : `#!/usr/bin/env sh\nexec "${target}" "$@"\n`;
  await writeFile(wrapper, body, { mode: 0o700 });
  if (process.platform !== 'win32') await chmod(wrapper, 0o700);
}

console.log(`Installed project-local harnesses under ${harnessRoot}`);
