import { defineConfig } from 'prisma/config';

// Prisma CLI configuration (ADR-0004). The schema is split into one file per module
// under prisma/schema/. DATABASE_URL comes from the environment or a local .env file.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the real environment (CI, production).
}

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // `prisma generate` needs no database; commands that do will fail on this placeholder.
    url: process.env.DATABASE_URL ?? 'postgresql://missing-DATABASE_URL',
  },
});
