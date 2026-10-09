import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The real package throws outside React Server Components; the marker means nothing in tests.
      'server-only': fileURLToPath(new URL('./test/server-only.ts', import.meta.url)),
    },
  },
});
