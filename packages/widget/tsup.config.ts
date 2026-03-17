import { defineConfig } from 'tsup';

export default defineConfig([
  // ESM and CJS for bundlers
  {
    entry: ['src/index.ts'],
    format: ['cjs', 'esm'],
    dts: false,
    clean: true,
    sourcemap: true,
  },
  // IIFE for direct browser usage (<script src="...tranzmit-widget.js">)
  {
    entry: ['src/index.ts'],
    format: ['iife'],
    globalName: 'TranzmitWidget',
    outExtension: () => ({ js: '.global.js' }),
    minify: true,
    sourcemap: true,
    target: 'es2020',
  },
]);
