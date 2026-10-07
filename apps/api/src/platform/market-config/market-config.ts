import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseMarketId } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';

const CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const TIME_ZONES = new Set(Intl.supportedValuesOf('timeZone'));

// Market locales always name a region: language[-Script]-REGION.
const LOCALE_SHAPE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?-[A-Z]{2}$/;
const locale = z.string().refine((value) => {
  if (!LOCALE_SHAPE.test(value)) return false;
  try {
    return Intl.getCanonicalLocales(value)[0] === value;
  } catch {
    return false;
  }
}, 'must be a BCP 47 locale of the form language-REGION');
const currency = z.string().refine((value) => CURRENCIES.has(value), 'must be an ISO 4217 code');
/** The Market code, by the kernel's single rule (`parseMarketId`). */
const marketCode = z.string().transform((value, context) => {
  const marketId = parseMarketId(value);
  if (marketId.ok) return marketId.value;
  context.addIssue('must be a market code such as "NZ"');
  return z.NEVER;
});

/** A per-minute limit of the generic per-origin rate limiter (identity design 6.8). */
const perMinute = z.number().int().min(1).max(100_000);

/**
 * Limits of the generic per-origin rate limiter (`platform/rate-limit/`; identity design 6.8,
 * ADR-0015 decision 3). The counters are kept per origin and are not split by Market (PF I11):
 * the limiter is the cross-Market control, and the request's Market chooses only the limit.
 */
const requestLimitsSchema = z.strictObject({
  /** Routes marked `@RateLimit('anonymous-identity')`: sign-up, sign-in, reset requests. */
  anonymousIdentityPerMinute: perMinute,
  /** Every other market-scoped route. */
  defaultPerMinute: perMinute,
});

/**
 * The identity policy section (identity design 8.5 `IdentityMarketPolicy`; design 15). Each
 * value is Hassan's number (identity design 6.5). A slice adds the values it reads: 1d the
 * password rules; slice 5 "approval required"; later slices lifetimes and limits.
 */
const identitySchema = z.strictObject({
  password: z
    .strictObject({
      /** Code points after NFKC; never below 15 (NIST SP 800-63B-4, single factor). */
      minLength: z.number().int().min(15).max(128),
      /** Code points after NFKC; at most 128, so the raw-input bound of 1024 bytes holds. */
      maxLength: z.number().int().min(64).max(128),
    })
    .refine((password) => password.minLength <= password.maxLength, {
      message: 'minLength must not exceed maxLength',
      path: ['minLength'],
    }),
  /**
   * The "you already have an account" notice goes to one account at most once in this many
   * hours (identity design 6.7: 24).
   */
  existingAccountNoticeHours: z.number().int().min(1).max(168),
});

const marketSchema = z
  .strictObject({
    code: marketCode,
    status: z.enum(['planned', 'soft_launch', 'active', 'suspended']),
    defaultLocale: locale,
    supportedLocales: z.array(locale).min(1),
    defaultCurrency: currency,
    settlementCurrency: currency,
    /** Fallback only (ADR-0005): sellers, locations and addresses carry their own zone. */
    timezone: z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone'),
    requestLimits: requestLimitsSchema,
    identity: identitySchema,
  })
  .refine((market) => market.supportedLocales.includes(market.defaultLocale), {
    message: 'supportedLocales must include defaultLocale',
    path: ['supportedLocales'],
  });

/** Market configuration as code (ADR-0003 decision 5). */
export type MarketConfig = Readonly<z.infer<typeof marketSchema>>;

export class InvalidMarketConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidMarketConfigError';
  }
}

/**
 * Reads `<CODE>.json` for each hosted market from the given directories and validates it.
 * Throws when a hosted market has no configuration or an invalid one, so a Region Stack
 * never starts half-configured.
 */
export function loadMarketConfigs(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
): ReadonlyMap<MarketId, MarketConfig> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidMarketConfigError(`Market "${code}" is configured more than once`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const markets = new Map<MarketId, MarketConfig>();
  for (const code of hostedMarkets) {
    const file = files.get(code);
    if (file === undefined) {
      throw new InvalidMarketConfigError(
        `Hosted market "${code}" has no configuration file (${code}.json)`,
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new InvalidMarketConfigError(`${file} is not valid JSON`);
    }
    const parsed = marketSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'market'}: ${issue.message}`)
        .join('; ');
      throw new InvalidMarketConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.code !== code) {
      throw new InvalidMarketConfigError(
        `${file} declares code "${parsed.data.code}"; it must match the file name`,
      );
    }
    markets.set(code, deepFreeze(parsed.data));
  }
  return markets;
}

/** Freezes the parsed configuration and every nested section: it never changes after boot. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}
