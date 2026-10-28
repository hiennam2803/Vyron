// Build mỗi entry thành 1 file IIFE độc lập (content script MV3 không dùng ES module).
import { build } from 'vite';
import { rm, mkdir, copyFile, cp } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

const entries = {
  'page-bridge': 'src/page/page-bridge.ts', // chạy trong MAIN world của trang
  content: 'src/content/index.ts', // isolated world
  popup: 'src/popup/popup.ts',
  'service-worker': 'src/background/service-worker.ts', // cache bản dịch (IndexedDB)
};

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await copyFile(resolve(root, 'manifest.json'), resolve(dist, 'manifest.json'));
await copyFile(resolve(root, 'src/popup/popup.html'), resolve(dist, 'popup.html'));
await copyFile(resolve(root, 'src/popup/popup.css'), resolve(dist, 'popup.css'));
// Logo/biểu tượng: thay icons/logo.png bằng logo của bạn (PNG vuông, tối thiểu 128x128).
await cp(resolve(root, 'icons'), resolve(dist, 'icons'), { recursive: true });

for (const [name, entry] of Object.entries(entries)) {
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      target: 'es2022',
      minify: false,
      sourcemap: false,
      watch: watch ? {} : null,
      lib: {
        entry,
        name: `vyron_${name.replace(/-/g, '_')}`,
        formats: ['iife'],
        fileName: () => `${name}.js`,
      },
    },
  });
  console.log(`built ${name}.js`);
}
console.log(watch ? 'watching for changes...' : `done -> ${dist}`);
