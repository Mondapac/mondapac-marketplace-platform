import path from 'node:path';
import { z } from 'zod';

// apps/api/{src|dist}/platform/config -> repository root
const DEFAULT_MARKET_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/markets');

/** A Market code as used in `market_id` columns (ADR-0004): 2-8 upper-case characters. */
const marketCode = z.string().regex(/^[A-Z][A-Z0-9_]{1,7}$/, 'must be a market code such as "NZ"');

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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  HOSTED_MARKETS: hostedMarkets,
  API_DOCS_ENABLED: z.enum(['true', 'false']).default('false'),
  MARKET_CONFIG_DIR: z.string().min(1).default(DEFAULT_MARKET_CONFIG_DIR),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgresql:// connection URL'),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly port: number;
  readonly logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  /** Markets this Region Stack serves (ADR-0003). Never empty, never defaulted. */
  readonly hostedMarkets: readonly string[];
  /** Serve Swagger UI at /docs. Off unless explicitly enabled (fails closed). */
  readonly apiDocsEnabled: boolean;
  /** Directories holding `<CODE>.json` Market configuration (ADR-0003 decision 5). */
  readonly marketConfigDirs: readonly string[];
  /** PostgreSQL connection URL. Contains credentials: never log it. */
  readonly databaseUrl: string;
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
  if (!parsed.success) {
    throw new InvalidConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join('.') || 'env'}: ${issue.message}`),
    );
  }
  return Object.freeze({
    nodeEnv: parsed.data.NODE_ENV,
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    hostedMarkets: Object.freeze([...parsed.data.HOSTED_MARKETS]),
    apiDocsEnabled: parsed.data.API_DOCS_ENABLED === 'true',
    marketConfigDirs: Object.freeze([path.resolve(parsed.data.MARKET_CONFIG_DIR)]),
    databaseUrl: parsed.data.DATABASE_URL,
  });
}
