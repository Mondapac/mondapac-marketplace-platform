import path from 'node:path';
import { parseMarketId } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';

// apps/api/{src|dist}/platform/config -> repository root
const DEFAULT_MARKET_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/markets');

/** A Market code as used in `market_id` columns (ADR-0004), by the kernel's single rule. */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

const hostedMarkets = z
  .string({ error: 'HOSTED_MARKETS is required; there is no default market (ADR-0003)' })
  .transform((value) =>
    value
      .split(',')
      .map((code) => code.trim())
      .filter((code) => code.length > 0),
  )
  .pipe(z.array(marketCode).min(1, 'HOSTED_MARKETS must list at least one market'))
  .refine((codes) => new Set(codes).size === codes.length, 'HOSTED_MARKETS has duplicates');

/** The two process roles (platform persistence design 8; ADR-0006 decision 4, ADR-0008 decision 1). */
export const APP_ROLES = ['api', 'worker'] as const;
export type AppRole = (typeof APP_ROLES)[number];

const envSchema = z.object({
  // Required, no default (PA7): a worker that silently started as `api` would relay nothing.
  APP_ROLE: z.enum(APP_ROLES, {
    error: 'APP_ROLE is required and must be "api" or "worker"; there is no default',
  }),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOSTED_MARKETS: hostedMarkets,
  API_DOCS_ENABLED: z.enum(['true', 'false']).default('false'),
  MARKET_CONFIG_DIR: z.string().min(1).default(DEFAULT_MARKET_CONFIG_DIR),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgresql:// connection URL'),
  // Kazem, spike 6 decision 2: an explicit pool maximum per process, 10 unless set.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
});

/** The migration role's URL: read by the prisma CLI, the scripts and test setup only. */
export const MIGRATION_DATABASE_URL = 'MIGRATION_DATABASE_URL';

export interface AppConfig {
  /**
   * `api` serves HTTP; `worker` runs the relay and the scheduler (platform persistence 8).
   * Read by `main.ts` only (and `platform/worker/`, P 12.2 rule 3); a module never branches on it.
   */
  readonly appRole: AppRole;
  readonly nodeEnv: 'development' | 'test' | 'production';
  /**
   * True when `NODE_ENV` was set in the environment, false when `nodeEnv` is the default. A
   * development-only stand-in (the local key wrapper) starts only on an explicit value, so a
   * deployment that forgets `NODE_ENV` fails closed (security review of slice 1c, M2).
   */
  readonly nodeEnvExplicit: boolean;
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Markets this Region Stack serves (ADR-0003). Never empty, never defaulted. */
  readonly hostedMarkets: readonly MarketId[];
  /** Serve Swagger UI at /docs. Off unless explicitly enabled (fails closed). */
  readonly apiDocsEnabled: boolean;
  /** Directories holding `<CODE>.json` Market configuration (ADR-0003 decision 5). */
  readonly marketConfigDirs: readonly string[];
  /** PostgreSQL connection URL. Contains credentials: never log it. */
  readonly databaseUrl: string;
  /**
   * The most pooled connections this process opens (platform persistence design 3.1 row 8).
   * `DATABASE_POOL_MAX`, 1 to 100, default 10.
   */
  readonly databasePoolMax: number;
}

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'InvalidConfigError';
  }
}

/**
 * Validates the process environment once at startup. The application refuses to start
 * on invalid configuration instead of failing later on first use.
 */
export function loadAppConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = envSchema.safeParse(env);
  const issues = parsed.success
    ? []
    : parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`);
  // The application never receives the migration role's URL (docs/design/data/platform.md
  // 10.7): present at all, an empty value included, it refuses to start. The value is never
  // printed.
  if (MIGRATION_DATABASE_URL in env) {
    issues.push(
      `${MIGRATION_DATABASE_URL}: must not be set for the application; it is for ` +
        'pnpm db:*, pnpm test:db and pnpm verify only',
    );
  }
  if (!parsed.success || issues.length > 0) throw new InvalidConfigError(issues);
  return Object.freeze({
    appRole: parsed.data.APP_ROLE,
    nodeEnv: parsed.data.NODE_ENV,
    nodeEnvExplicit: env.NODE_ENV !== undefined,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    hostedMarkets: Object.freeze([...parsed.data.HOSTED_MARKETS]),
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED === 'true',
    marketConfigDirs: Object.freeze([path.resolve(parsed.data.MARKET_CONFIG_DIR)]),
    databaseUrl: parsed.data.DATABASE_URL,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
  });
}
