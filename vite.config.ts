import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { extensionPlugin } from './build/extension-plugin.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ mode }) => ({
  // страницы открываются по chrome-extension://…/popup.html — пути только относительные
  base: './',
  plugins: [extensionPlugin(root)],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    // полифил modulepreload вставляет inline-скрипт, который запрещает CSP MV3
    modulePreload: false,
    minify: false,
    sourcemap: mode === 'development',
    rolldownOptions: {
      input: {
        popup: r('popup.html'),
        sidepanel: r('sidepanel.html'),
        ocr: r('ocr.html'),
        engine: r('engine.html'),
        background: r('src/background.ts')
      },
      output: {
        // на background.js ссылается манифест — имя без хеша; остальное тоже без хешей, чтобы было читаемо
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name].js'),
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]'
      }
    }
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true
  }
}));
