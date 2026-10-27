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
const MODEL_ID = '[A-Za-z0-9][A-Za-z0-9._:/@-]{0,99}';
const API_KEY = '[A-Za-z0-9_-]{20,500}';
const PRICE = '\\d{1,4}(?:\\.\\d{1,6})?/\\d{1,4}(?:\\.\\d{1,6})?';
const MARKET_VALUE = (value: string): string => `[A-Z][A-Z0-9_]{1,7}=${value}`;
/** A carrier key or webhook secret: long enough to be guessed by no one, in a URL-safe alphabet. */
const CARRIER_SECRET = '[A-Za-z0-9_-]{24,200}';
/** An external fleet's customer or client id: an identifier, not a secret, but still not logged. */
const FLEET_ID = '[A-Za-z0-9_-]{8,100}';

/** A Zoom2u API key (a bearer token): printable token characters, 20 to 500 of them. */
const ZOOM2U_KEY = '[A-Za-z0-9._~+/-]{20,500}';

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
  // The Stripe payment method configuration (pmc_) hosted Checkout uses: cards with Apple Pay and
  // Google Pay only. Stripe no longer takes payment_method_types on a Checkout Session, so the
  // allowed methods live in this configuration (scripts/stripe-test/ensure-card-only-config.mjs makes
  // it). Unset: ordering opens no payment page, rather than one with every method of the account.
  // An id, not a secret.
  STRIPE_PAYMENT_METHOD_CONFIGURATION: z
    .string()
    .regex(/^pmc_[A-Za-z0-9]{8,64}$/, 'must be a Stripe payment method configuration id (pmc_)')
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
  // SHP-02/03: the marketplace's merchant API key at Mondapac Drive and the secret Drive signs its
  // status webhooks with, each as MARKET=value pairs separated by commas (each Market at most once
  // and only hosted ones). A Market without both has its real-time carrier off (sellers ship
  // themselves) and its carrier webhook answers 503. Server secrets, never echoed; checked in
  // parseMarketValues below.
  MONDAPAC_DRIVE_API_KEY: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(CARRIER_SECRET)}(,${MARKET_VALUE(CARRIER_SECRET)})*$`),
      'must be MARKET=key pairs separated by commas (a key is 24 to 200 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  MONDAPAC_DRIVE_WEBHOOK_SECRET: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(CARRIER_SECRET)}(,${MARKET_VALUE(CARRIER_SECRET)})*$`),
      'must be MARKET=secret pairs separated by commas (a secret is 24 to 200 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  // Phase 6 package 5b, the external fleet Uber Direct: its customer id, OAuth client id and OAuth
  // client secret, each as MARKET=value pairs separated by commas (each Market at most once and
  // only hosted ones). A Market without all three has Uber Direct off, whatever its
  // `shipping.uberDirect.enabled` says. Server secrets, never echoed; checked in parseMarketValues.
  UBER_DIRECT_CUSTOMER_ID: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(FLEET_ID)}(,${MARKET_VALUE(FLEET_ID)})*$`),
      'must be MARKET=id pairs separated by commas (an id is 8 to 100 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  UBER_DIRECT_CLIENT_ID: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(FLEET_ID)}(,${MARKET_VALUE(FLEET_ID)})*$`),
      'must be MARKET=id pairs separated by commas (an id is 8 to 100 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  UBER_DIRECT_CLIENT_SECRET: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(CARRIER_SECRET)}(,${MARKET_VALUE(CARRIER_SECRET)})*$`),
      'must be MARKET=secret pairs separated by commas (a secret is 24 to 200 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  // Phase 6 package 5c, the external fleet Zoom2u: its API key (a bearer token) as MARKET=key
  // pairs separated by commas (each Market at most once and only hosted ones). A Market without
  // it has Zoom2u off, whatever its `shipping.zoom2u.enabled` says. A server secret, never
  // echoed; checked in parseMarketValues.
  ZOOM2U_API_KEY: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(ZOOM2U_KEY)}(,${MARKET_VALUE(ZOOM2U_KEY)})*$`),
      'must be MARKET=key pairs separated by commas (a key is 20 to 500 of A-Z a-z 0-9 . _ ~ + / -)',
    )
    .optional(),
  // ADR-0037: the BFF networks and their keys. Both empty or unset: the feature is off. Parsed
  // and checked by parseClientAddressTrust below; a secret is never echoed.
  TRUSTED_BFF_CIDRS: z.string().optional(),
  CLIENT_ADDRESS_KEYS: z.string().optional(),
  // Buyer assistant (ADR-0019 R7: provider and model are Market configuration, no default):
  // MARKET=value pairs separated by commas, each Market at most once and only hosted ones. A
  // Market without its key, the chosen tier's model or that model's price stays off whatever its
  // settings say. The key is a server secret, never echoed; the admin screen learns only whether
  // it is set. Checked in parseMarketValues below.
  ASSISTANT_MODEL_API_KEY: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(API_KEY)}(,${MARKET_VALUE(API_KEY)})*$`),
      'must be MARKET=key pairs separated by commas (a key is 20 to 500 of A-Z a-z 0-9 _ -)',
    )
    .optional(),
  // The provider model id of each tier the admin may choose, per Market (configuration, not code).
  ASSISTANT_MODEL_FAST: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(MODEL_ID)}(,${MARKET_VALUE(MODEL_ID)})*$`),
      'must be MARKET=model pairs separated by commas (a model id is letters, digits, . _ : / @ -)',
    )
    .optional(),
  ASSISTANT_MODEL_BALANCED: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(MODEL_ID)}(,${MARKET_VALUE(MODEL_ID)})*$`),
      'must be MARKET=model pairs separated by commas (a model id is letters, digits, . _ : / @ -)',
    )
    .optional(),
  // The list price of each tier's model, per Market, as "input/output" US dollars per million
  // tokens (for example AU=0.1/0.5). The spend caps are counted with it, so a tier without a
  // price is off.
  ASSISTANT_MODEL_PRICE_FAST: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(PRICE)}(,${MARKET_VALUE(PRICE)})*$`),
      'must be MARKET=input/output pairs separated by commas (US dollars per million tokens)',
    )
    .optional(),
  ASSISTANT_MODEL_PRICE_BALANCED: z
    .string()
    .regex(
      new RegExp(`^${MARKET_VALUE(PRICE)}(,${MARKET_VALUE(PRICE)})*$`),
      'must be MARKET=input/output pairs separated by commas (US dollars per million tokens)',
    )
    .optional(),
  // Social sign-in: the Google OAuth client of this stack (Google Cloud console, "Web
  // application"). Both or neither; unset: Google sign-in is off in every Market. The secret is a
  // server secret and is never echoed. Each Market that offers it also names its redirect URI
  // (Market config identity.socialSignIn.google.redirectUri).
  GOOGLE_SIGN_IN_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{10,200}$/, 'must be a Google OAuth client id')
    .optional(),
  GOOGLE_SIGN_IN_CLIENT_SECRET: z
    .string()
    .regex(/^[\x21-\x7e]{10,200}$/, 'must be 10 to 200 printable ASCII characters')
    .optional(),
});

/** The model price of a tier in one Market: pico US dollars per token (1e-12 USD). */
export interface ModelTokenPrice {
  readonly inputPicoUsd: number;
  readonly outputPicoUsd: number;
}

/** `ASSISTANT_MODEL_*` by Market; a Market missing from a record has no value for it. */
export interface AssistantModelConfig {
  readonly apiKeys: Readonly<Record<string, string>>;
  readonly models: Readonly<Record<'fast' | 'balanced', Readonly<Record<string, string>>>>;
  readonly prices: Readonly<Record<'fast' | 'balanced', Readonly<Record<string, ModelTokenPrice>>>>;
}

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
   * The card-only payment method configuration of hosted Checkout
   * (`STRIPE_PAYMENT_METHOD_CONFIGURATION`), or null: then ordering opens no payment page.
   */
  readonly stripePaymentMethodConfiguration: string | null;
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
   * The buyer assistant's model configuration per Market (ADR-0019 R7), read by `platform/ai`
   * only. Holds secrets: never log this object whole; the settings report only set or not.
   */
  readonly assistantModels: AssistantModelConfig;
  /**
   * The Google OAuth client for social sign-in (`GOOGLE_SIGN_IN_CLIENT_ID`, `_SECRET`), or null:
   * then Google sign-in is off. Holds a secret: read by identity's sign-in providers alone.
   */
  readonly googleSignIn: Readonly<{ clientId: string; clientSecret: string }> | null;
  /**
   * The Mondapac Drive merchant API key and webhook secret of each hosted Market
   * (`MONDAPAC_DRIVE_API_KEY`, `MONDAPAC_DRIVE_WEBHOOK_SECRET`). Holds secrets: read by shipping's
   * carrier adapter and webhook signature check alone.
   */
  readonly mondapacDrive: Readonly<{
    apiKeys: Readonly<Record<string, string>>;
    webhookSecrets: Readonly<Record<string, string>>;
  }>;
  /**
   * The Uber Direct credentials of each hosted Market (`UBER_DIRECT_CUSTOMER_ID`,
   * `UBER_DIRECT_CLIENT_ID`, `UBER_DIRECT_CLIENT_SECRET`). Holds secrets: read by shipping's Uber
   * Direct adapter alone.
   */
  readonly uberDirect: Readonly<{
    customerIds: Readonly<Record<string, string>>;
    clientIds: Readonly<Record<string, string>>;
    clientSecrets: Readonly<Record<string, string>>;
  }>;
  /**
   * The Zoom2u API key of each hosted Market (`ZOOM2U_API_KEY`). Holds secrets: read by
   * shipping's Zoom2u adapter alone.
   */
  readonly zoom2u: Readonly<{
    apiKeys: Readonly<Record<string, string>>;
  }>;
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
 * A `MARKET=value` list (already pattern-checked) as one value per Market: each Market at most
 * once and only hosted ones. Issues name the variable and the Market, never a value.
 */
export function parseMarketValues(
  value: string | undefined,
  hosted: readonly string[],
  variable: string,
): { values: Readonly<Record<string, string>>; issues: string[] } {
  if (value === undefined) return { values: Object.freeze({}), issues: [] };
  const values: Record<string, string> = {};
  const issues: string[] = [];
  for (const pair of value.split(',')) {
    const at = pair.indexOf('=');
    const market = pair.slice(0, at);
    if (market in values) issues.push(`${variable}: ${market} is named twice`);
    else if (!hosted.includes(market))
      issues.push(`${variable}: ${market} is not in HOSTED_MARKETS`);
    values[market] = pair.slice(at + 1);
  }
  return { values: Object.freeze(values), issues };
}

/** "input/output" US dollars per million tokens as pico US dollars per token (exact: 6 decimals). */
function tokenPriceOf(value: string): ModelTokenPrice {
  const [input, output] = value.split('/').map((part) => Math.round(Number(part) * 1_000_000));
  return Object.freeze({ inputPicoUsd: input!, outputPicoUsd: output! });
}

function assistantModelConfig(env: z.infer<typeof envSchema>): {
  config: AssistantModelConfig;
  issues: string[];
} {
  const hosted = env.HOSTED_MARKETS;
  const read = (variable: keyof z.infer<typeof envSchema>) =>
    parseMarketValues(env[variable] as string | undefined, hosted, variable);
  const keys = read('ASSISTANT_MODEL_API_KEY');
  const fast = read('ASSISTANT_MODEL_FAST');
  const balanced = read('ASSISTANT_MODEL_BALANCED');
  const fastPrice = read('ASSISTANT_MODEL_PRICE_FAST');
  const balancedPrice = read('ASSISTANT_MODEL_PRICE_BALANCED');
  const prices = (values: Readonly<Record<string, string>>) =>
    Object.freeze(
      Object.fromEntries(Object.entries(values).map(([market, v]) => [market, tokenPriceOf(v)])),
    );
  return {
    config: Object.freeze({
      apiKeys: keys.values,
      models: Object.freeze({ fast: fast.values, balanced: balanced.values }),
      prices: Object.freeze({
        fast: prices(fastPrice.values),
        balanced: prices(balancedPrice.values),
      }),
    }),
    issues: [keys, fast, balanced, fastPrice, balancedPrice].flatMap((read) => read.issues),
  };
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
  if (
    parsed.success &&
    (parsed.data.GOOGLE_SIGN_IN_CLIENT_ID === undefined) !==
      (parsed.data.GOOGLE_SIGN_IN_CLIENT_SECRET === undefined)
  ) {
    issues.push('GOOGLE_SIGN_IN_CLIENT_ID and GOOGLE_SIGN_IN_CLIENT_SECRET: set both or neither');
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
  const driveKeys = parsed.success
    ? parseMarketValues(
        parsed.data.MONDAPAC_DRIVE_API_KEY,
        parsed.data.HOSTED_MARKETS,
        'MONDAPAC_DRIVE_API_KEY',
      )
    : { values: {}, issues: [] };
  issues.push(...driveKeys.issues);
  const driveSecrets = parsed.success
    ? parseMarketValues(
        parsed.data.MONDAPAC_DRIVE_WEBHOOK_SECRET,
        parsed.data.HOSTED_MARKETS,
        'MONDAPAC_DRIVE_WEBHOOK_SECRET',
      )
    : { values: {}, issues: [] };
  issues.push(...driveSecrets.issues);
  // The key goes out with every call; the secret proves Drive's webhooks. One leaked value must
  // not give both directions.
  for (const [market, secret] of Object.entries(driveSecrets.values)) {
    if (driveKeys.values[market] === secret) {
      issues.push(
        `MONDAPAC_DRIVE_WEBHOOK_SECRET: ${market} must differ from MONDAPAC_DRIVE_API_KEY`,
      );
    }
  }
  const uberValues = (
    variable: 'UBER_DIRECT_CUSTOMER_ID' | 'UBER_DIRECT_CLIENT_ID' | 'UBER_DIRECT_CLIENT_SECRET',
  ) =>
    parsed.success
      ? parseMarketValues(parsed.data[variable], parsed.data.HOSTED_MARKETS, variable)
      : { values: {}, issues: [] };
  const uberCustomers = uberValues('UBER_DIRECT_CUSTOMER_ID');
  const uberClients = uberValues('UBER_DIRECT_CLIENT_ID');
  const uberSecrets = uberValues('UBER_DIRECT_CLIENT_SECRET');
  issues.push(...uberCustomers.issues, ...uberClients.issues, ...uberSecrets.issues);
  const zoom2uKeys = parsed.success
    ? parseMarketValues(parsed.data.ZOOM2U_API_KEY, parsed.data.HOSTED_MARKETS, 'ZOOM2U_API_KEY')
    : { values: {}, issues: [] };
  issues.push(...zoom2uKeys.issues);
  const assistant = parsed.success
    ? assistantModelConfig(parsed.data)
    : { config: null, issues: [] };
  issues.push(...assistant.issues);
  if (!parsed.success || issues.length > 0 || assistant.config === null) {
    throw new InvalidConfigError(issues);
  }
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
    stripePaymentMethodConfiguration: parsed.data.STRIPE_PAYMENT_METHOD_CONFIGURATION ?? null,
    stripeWebhookSecrets: webhookSecrets.secrets,
    stripeConnectWebhookSecrets: connectSecrets.secrets,
    clientAddressTrust: clientAddress.trust,
    assistantModels: assistant.config,
    googleSignIn:
      parsed.data.GOOGLE_SIGN_IN_CLIENT_ID === undefined ||
      parsed.data.GOOGLE_SIGN_IN_CLIENT_SECRET === undefined
        ? null
        : Object.freeze({
            clientId: parsed.data.GOOGLE_SIGN_IN_CLIENT_ID,
            clientSecret: parsed.data.GOOGLE_SIGN_IN_CLIENT_SECRET,
          }),
    mondapacDrive: Object.freeze({
      apiKeys: driveKeys.values,
      webhookSecrets: driveSecrets.values,
    }),
    uberDirect: Object.freeze({
      customerIds: uberCustomers.values,
      clientIds: uberClients.values,
      clientSecrets: uberSecrets.values,
    }),
    zoom2u: Object.freeze({ apiKeys: zoom2uKeys.values }),
  });
}
