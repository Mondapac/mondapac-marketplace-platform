import path from 'node:path';
import { parseMarketId } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';
import { parseClientAddressTrust, type ClientAddressTrust } from '../http/client-address-trust';

// apps/api/{src|dist}/platform/config -> repository root
const DEFAULT_MARKET_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/markets');
const DEFAULT_SERVICE_AREA_CONFIG_DIR = path.resolve(
  __dirname,
  '../../../../../config/service-areas',
);
const DEFAULT_LOCALE_CONFIG_DIR = path.resolve(__dirname, '../../../../../config/locales');

/** A Market code as used in `market_id` columns (ADR-0004), by the kernel's single rule. */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

const WEBHOOK_SECRET = 'whsec_[A-Za-z0-9+/=_]{8,200}';
const MARKET_SECRET = `[A-Z][A-Z0-9_]{1,7}=${WEBHOOK_SECRET}`;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}$/;

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
  CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED: z.enum(['true', 'false']).default('false'),
  MARKET_CONFIG_DIR: z.string().min(1).default(DEFAULT_MARKET_CONFIG_DIR),
  SERVICE_AREA_CONFIG_DIR: z.string().min(1).default(DEFAULT_SERVICE_AREA_CONFIG_DIR),
  LOCALE_CONFIG_DIR: z.string().min(1).default(DEFAULT_LOCALE_CONFIG_DIR),
  DATABASE_URL: z
    .string({ error: 'DATABASE_URL is required' })
    .regex(/^postgres(ql)?:\/\/\S+$/, 'must be a postgresql:// connection URL'),
  // Kazem, spike 6 decision 2: an explicit pool maximum per process, 10 unless set.
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  // Identity design 9: the local mail catcher's HTTP base URL (Mailpit's UI/API port).
  MAIL_CATCHER_URL: z
    .url({ protocol: /^https?$/, error: 'must be an http(s) URL such as http://localhost:8025' })
    .optional(),
  // Catalog slice 13: the directory of the local object store (product photos). Unset: photo
  // uploads answer "unavailable". An S3-compatible adapter replaces it for production.
  OBJECT_STORE_DIR: z.string().min(1).max(500).optional(),
  // Phase 5: the Stripe secret key for hosted Checkout. Test mode only until the live gates
  // (pen test, tax agent) are passed: a live key is refused at boot. The value is never echoed.
  STRIPE_SECRET_KEY: z
    .string()
    .regex(
      /^(sk|rk)_test_[A-Za-z0-9_]{8,200}$/,
      'must be a Stripe test-mode key (sk_test_ or rk_test_); live keys are refused until the live gates are passed',
    )
    .optional(),
  // Phase 5 package 2: the signing secrets of the Stripe webhook endpoints (whsec_), one endpoint
  // per Market. Either one secret for every hosted Market (`stripe listen`, or one Market) or
  // `AU=whsec_...,NZ=whsec_...`. Unset for a Market, its webhook answers 503 and Stripe retries.
  // The value is never echoed; checked against HOSTED_MARKETS in parseStripeWebhookSecrets.
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .regex(
      new RegExp(`^(${WEBHOOK_SECRET}|${MARKET_SECRET}(,${MARKET_SECRET})*)$`),
      'must be a Stripe webhook signing secret (whsec_), or MARKET=whsec_ pairs separated by commas',
    )
    .optional(),
  // Phase 5 package 3: the signing secrets of the Stripe "Connect" webhook endpoints (events of
  // connected accounts), same format and rules as STRIPE_WEBHOOK_SECRET. Stripe signs those
  // events with their own secret, so the platform and Connect secrets are separate values.
  STRIPE_CONNECT_WEBHOOK_SECRET: z
    .string()
    .regex(
      new RegExp(`^(${WEBHOOK_SECRET}|${MARKET_SECRET}(,${MARKET_SECRET})*)$`),
      'must be a Stripe webhook signing secret (whsec_), or MARKET=whsec_ pairs separated by commas',
    )
    .optional(),
  // ADR-0037: the BFF networks and their keys. Both empty or unset: the feature is off. Parsed
  // and checked by parseClientAddressTrust below; a secret is never echoed.
  TRUSTED_BFF_CIDRS: z.string().optional(),
  CLIENT_ADDRESS_KEYS: z.string().optional(),
  // Buyer assistant: the model provider's API key, a server secret. Unset: the assistant stays
  // off whatever its settings say. The value is never echoed; the admin screen learns only
  // whether it is set.
  ASSISTANT_MODEL_API_KEY: z
    .string()
    .regex(/^[\x21-\x7e]{20,500}$/, 'must be 20 to 500 printable ASCII characters')
    .optional(),
  // Buyer assistant: the provider model id of each tier the admin may choose (configuration, not
  // code). Unset: that tier is not configured and the assistant stays off while it is chosen.
  ASSISTANT_MODEL_FAST: z
    .string()
    .regex(MODEL_ID, 'must be a provider model id (letters, digits, . _ : / @ -)')
    .optional(),
  ASSISTANT_MODEL_BALANCED: z
    .string()
    .regex(MODEL_ID, 'must be a provider model id (letters, digits, . _ : / @ -)')
    .optional(),
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
  /** A reviewer may download a submitted certificate file. Off until the PDF scan hardening lands. */
  readonly certificationReviewerDocumentsEnabled: boolean;
  /** Directories holding `<CODE>.json` Market configuration (ADR-0003 decision 5). */
  readonly marketConfigDirs: readonly string[];
  /** Directories holding `<MARKET>.json` ServiceArea postcode sets (ADR-0005 decision 7). */
  readonly serviceAreaConfigDirs: readonly string[];
  /**
   * Directories holding translation catalogues, `<locale>/<module>.json` (INTL-11; identity
   * design 9). `LOCALE_CONFIG_DIR`, default `config/locales`.
   */
  readonly localeConfigDirs: readonly string[];
  /** PostgreSQL connection URL. Contains credentials: never log it. */
  readonly databaseUrl: string;
  /**
   * The most pooled connections this process opens (platform persistence design 3.1 row 8).
   * `DATABASE_POOL_MAX`, 1 to 100, default 10.
   */
  readonly databasePoolMax: number;
  /**
   * The local mail catcher's base URL (`MAIL_CATCHER_URL`), or null: then every mail send
   * fails and its delivery is retried and dead-lettered (identity design 9). Set, it is refused
   * unless `NODE_ENV` is explicitly `development` or `test` (`platform/mail/`).
   */
  readonly mailCatcherUrl: string | null;
  /**
   * The directory of the local object store (`OBJECT_STORE_DIR`), resolved to an absolute path,
   * or null: then storing a file fails with "unavailable" (`platform/storage/`).
   */
  readonly objectStoreDir: string | null;
  /**
   * The Stripe secret key (`STRIPE_SECRET_KEY`, test mode only), or null: then ordering cannot
   * open a payment page and a checkout answers "payment unavailable". Holds a secret: never log
   * this object whole; read by ordering's Stripe adapter alone.
   */
  readonly stripeSecretKey: string | null;
  /**
   * The Stripe webhook signing secret of each hosted Market (`STRIPE_WEBHOOK_SECRET`); a Market
   * without one refuses every event with 503 and Stripe retries it later. Holds secrets: read
   * by payments' signature check alone.
   */
  readonly stripeWebhookSecrets: Readonly<Record<string, string>>;
  /** The same for the Connect endpoint (`STRIPE_CONNECT_WEBHOOK_SECRET`): connected-account events. */
  readonly stripeConnectWebhookSecrets: Readonly<Record<string, string>>;
  /**
   * Who may prove a client address, and with which keys (ADR-0037 decisions 4 and 5): from
   * `TRUSTED_BFF_CIDRS` and `CLIENT_ADDRESS_KEYS`. `null` when both are empty: the address is the
   * socket's. Holds secrets, which print as a marker only; read by `configureApp` alone.
   */
  readonly clientAddressTrust: ClientAddressTrust | null;
  /**
   * The buyer assistant's model API key (`ASSISTANT_MODEL_API_KEY`), or null: then the assistant
   * stays off. Holds a secret: never log this object whole; the settings report only set or not.
   */
  readonly assistantModelApiKey: string | null;
  /** The provider model id of each assistant tier (`ASSISTANT_MODEL_FAST`, `_BALANCED`), or null. */
  readonly assistantModels: Readonly<{ fast: string | null; balanced: string | null }>;
}

/** The log levels a worker may run at: every one that still writes info lines. */
const WORKER_LOG_LEVELS: ReadonlySet<string> = new Set(['info', 'debug', 'trace']);

export class InvalidConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'InvalidConfigError';
  }
}

/**
 * `STRIPE_WEBHOOK_SECRET` (already pattern-checked) as one secret per hosted Market: a bare
 * secret serves every hosted Market; a list names each Market once, and only hosted ones. Issues
 * never contain a secret.
 */
export function parseStripeWebhookSecrets(
  value: string | undefined,
  hosted: readonly string[],
  variable = 'STRIPE_WEBHOOK_SECRET',
): { secrets: Readonly<Record<string, string>>; issues: string[] } {
  if (value === undefined) return { secrets: Object.freeze({}), issues: [] };
  if (value.startsWith('whsec_')) {
    return {
      secrets: Object.freeze(Object.fromEntries(hosted.map((m) => [m, value]))),
      issues: [],
    };
  }
  const secrets: Record<string, string> = {};
  const issues: string[] = [];
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=');
    const market = pair.slice(0, at);
    if (market in secrets) issues.push(`${variable}: ${market} is named twice`);
    else if (!hosted.includes(market)) {
      issues.push(`${variable}: ${market} is not in HOSTED_MARKETS`);
    }
    secrets[market] = pair.slice(at + 1);
  }
  return { secrets: Object.freeze(secrets), issues };
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
  // The worker writes the audit chain's anchors as info lines (LogAnchorSink, PA 8): a level
  // above info would drop them silently, so the worker refuses one (Hassan, 6b review L1).
  if (
    parsed.success &&
    parsed.data.APP_ROLE === 'worker' &&
    !WORKER_LOG_LEVELS.has(parsed.data.LOG_LEVEL)
  ) {
    issues.push(
      'LOG_LEVEL: the worker logs at info, debug or trace (audit anchors are info lines)',
    );
  }
  const clientAddress = parseClientAddressTrust(env.TRUSTED_BFF_CIDRS, env.CLIENT_ADDRESS_KEYS);
  issues.push(...clientAddress.issues);
  const webhookSecrets = parsed.success
    ? parseStripeWebhookSecrets(parsed.data.STRIPE_WEBHOOK_SECRET, parsed.data.HOSTED_MARKETS)
    : { secrets: {}, issues: [] };
  issues.push(...webhookSecrets.issues);
  const connectSecrets = parsed.success
    ? parseStripeWebhookSecrets(
        parsed.data.STRIPE_CONNECT_WEBHOOK_SECRET,
        parsed.data.HOSTED_MARKETS,
        'STRIPE_CONNECT_WEBHOOK_SECRET',
      )
    : { secrets: {}, issues: [] };
  issues.push(...connectSecrets.issues);
  // The Connect endpoint is told from the platform endpoint by its secret: equal values would
  // make every Connect event look like a platform event.
  for (const [market, secret] of Object.entries(connectSecrets.secrets)) {
    if (webhookSecrets.secrets[market] === secret) {
      issues.push(
        `STRIPE_CONNECT_WEBHOOK_SECRET: ${market} must differ from STRIPE_WEBHOOK_SECRET`,
      );
    }
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
    certificationReviewerDocumentsEnabled:
      parsed.data.CERTIFICATION_REVIEWER_DOCUMENTS_ENABLED === 'true',
    marketConfigDirs: Object.freeze([path.resolve(parsed.data.MARKET_CONFIG_DIR)]),
    serviceAreaConfigDirs: Object.freeze([path.resolve(parsed.data.SERVICE_AREA_CONFIG_DIR)]),
    localeConfigDirs: Object.freeze([path.resolve(parsed.data.LOCALE_CONFIG_DIR)]),
    databaseUrl: parsed.data.DATABASE_URL,
    databasePoolMax: parsed.data.DATABASE_POOL_MAX,
    mailCatcherUrl: parsed.data.MAIL_CATCHER_URL ?? null,
    objectStoreDir:
      parsed.data.OBJECT_STORE_DIR === undefined
        ? null
        : path.resolve(parsed.data.OBJECT_STORE_DIR),
    stripeSecretKey: parsed.data.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecrets: webhookSecrets.secrets,
    stripeConnectWebhookSecrets: connectSecrets.secrets,
    clientAddressTrust: clientAddress.trust,
    assistantModelApiKey: parsed.data.ASSISTANT_MODEL_API_KEY ?? null,
    assistantModels: Object.freeze({
      fast: parsed.data.ASSISTANT_MODEL_FAST ?? null,
      balanced: parsed.data.ASSISTANT_MODEL_BALANCED ?? null,
    }),
  });
}
