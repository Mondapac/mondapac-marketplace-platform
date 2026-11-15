import { fileURLToPath } from 'node:url';
const here = (p) => fileURLToPath(new URL(p, import.meta.url));
export default {
  root: here('.'),
  css: { postcss: here('../..') },
  resolve: { alias: { 'next/navigation': here('./nav-stub.ts') } },
  define: { 'process.env.NODE_ENV': '"production"' },
  build: { outDir: here('./dist'), emptyOutDir: true },
};
