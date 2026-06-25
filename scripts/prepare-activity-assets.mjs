import { copyFile, mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { APP } from '../src/admin/control-center-assets.js';

const publicDir = path.resolve('activity/public');
await mkdir(publicDir, { recursive: true });
await writeFile(path.join(publicDir, 'control-center-app.js'), `${APP}\n`, 'utf8');
try {
  await access(path.join(publicDir, 'config.json'));
} catch {
  await copyFile(path.join(publicDir, 'config.example.json'), path.join(publicDir, 'config.json'));
  console.warn('activity/public/config.json was generated from config.example.json; run npm run admin:provision before deployment.');
}
