import { defineConfig } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: directory,
  publicDir: path.join(directory, 'public'),
  base: '/',
  build: {
    outDir: path.resolve(directory, '..', 'dist', 'activity'),
    emptyOutDir: true,
    sourcemap: true,
  },
});
