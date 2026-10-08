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

/** Minutes, at most 60 days: the unit of every lifetime, window and block below. */
const minutes = z.number().int().min(1).max(86_400);

/**
 * A session lifetime of one population (identity design 6.1): the idle timeout and the
 * absolute lifetime, both fixed on the session at creation (M2).
 */
const sessionLifetimeSchema = z
  .strictObject({ idleTimeoutMinutes: minutes, absoluteLifetimeMinutes: minutes })
  .refine((lifetime) => lifetime.idleTimeoutMinutes <= lifetime.absoluteLifetimeMinutes, {
    message: 'idleTimeoutMinutes must not exceed absoluteLifetimeMinutes',
    path: ['idleTimeoutMinutes'],
  });

/**
 * One throttle counter of identity design 6.8: at most `limit` attempts in a fixed window of
 * `windowMinutes`; a failure that reaches the limit blocks the counter for `blockMinutes` (0:
 * no block, the window alone refuses until it ends).
 */
const throttleCounterSchema = z.strictObject({
  limit: z.number().int().min(1).max(1000),
  windowMinutes: z.number().int().min(1).max(1440),
  blockMinutes: z.number().int().min(0).max(1440),
});

/** Hosts a browser resolves to this machine only: the one place a plain-http page is allowed. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * A page a mail links to: an absolute https URL without a fragment (the token goes there) and
 * without credentials (Hassan L4). Plain http is accepted only for a loopback host
 * (`localhost`, `*.localhost`, `127.0.0.1`, `[::1]`), for local development, so a mailed token
 * never crosses a network in clear text.
 */
const pageUrl = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      const loopback = LOOPBACK_HOSTS.has(url.hostname) || url.hostname.endsWith('.localhost');
      return (
        (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
        !value.includes('#') &&
        url.username === '' &&
        url.password === ''
      );
    } catch {
      return false;
    }
  }, 'must be an absolute https URL (http only for a loopback host) without a fragment, such as "https://panel.example/page"');

/**
 * The identity policy section (identity design 8.5 `IdentityMarketPolicy`; design 15). Each
 * value is Hassan's number (identity design 6.1, 6.5, 6.8; data design 3.6). A slice adds the
 * values it reads: 1d the password rules; slice 2 the customer session lifetime, the sign-in
 * and mail throttles and the retention of sign-in records; slice 3 the links, the retention of
 * unverified accounts and the mail sender; slice 5 the seller lifetimes ("approval required"
 * lives in the `sellers` section); slice 7 the admin lifetime.
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
  /** Per population; a population without a lifetime here cannot open a session. */
  sessions: z.strictObject({
    customer: sessionLifetimeSchema,
    /** Seller side, default (6.1: 12 hours idle, 24 absolute; a cookie without Max-Age). */
    seller: sessionLifetimeSchema.optional(),
  }),
  /**
   * "Keep me signed in" (identity design 6.1, 14.4): per population that offers it, opt-in at
   * sign-in. Seller side only (14 days idle, 30 absolute); a population absent here never gets it.
   */
  keepSignedInSessions: z.strictObject({ seller: sessionLifetimeSchema.optional() }),
  /** The sign-in counters of 6.8, per Market (A6). */
  signInThrottles: z.strictObject({
    /** `sign-in.account-origin`: failed sign-ins per address and origin (AC 13). */
    accountOrigin: throttleCounterSchema,
    /** `sign-in.account`: failed sign-ins per address, all origins. */
    account: throttleCounterSchema,
    /** `sign-in.origin` (HF3): failed sign-ins per origin, any address. */
    origin: throttleCounterSchema,
  }),
  /** The mail counters of 6.8: sign-up, reset, verification re-send, enrolment, invitation. */
  mailThrottles: z.strictObject({ account: throttleCounterSchema, origin: throttleCounterSchema }),
  /** Sign-in records are deleted this many days after the attempt (H3: 90). */
  signInRecordRetentionDays: z.number().int().min(1).max(3650),
  /**
   * One-time links (identity design 6.6, 9; slice 3). `lifetimeMinutes` per purpose, from the
   * issue (HF15: verification 24 hours); a purpose without one is never issued. `targets`: the
   * page a mail links to, per population and page (`LinkTargets`; hosts wait for D2).
   */
  links: z.strictObject({
    // Hassan L3: a verification link lives at most 24 hours (identity design 6.6).
    lifetimeMinutes: z.strictObject({ 'verify-email': z.number().int().min(1).max(1440) }),
    targets: z.strictObject({
      customer: z.strictObject({ 'verify-email': pageUrl, 'sign-in': pageUrl }),
      /** The seller panel's pages (slice 5); absent for a Market without seller sign-up. */
      seller: z.strictObject({ 'verify-email': pageUrl, 'sign-in': pageUrl }).optional(),
    }),
  }),
  /** A never-verified account is deleted this many days after its latest sign-up (M5: 7). */
  unverifiedAccountRetentionDays: z.number().int().min(1).max(30),
  /** The sender of the Market's mail (identity design 9). */
  mail: z.strictObject({
    fromAddress: z.email().max(254),
    fromName: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[^\p{Cc}\p{Cf}"<>]+$/u, 'must be plain text without control or format characters'),
  }),
});

/**
 * The exact origins (`scheme://host[:port]`) whose browsers may send an unsafe request to this
 * Market's routes (identity design 6.4, HF14). A request with an `Origin` header that is not on
 * the list is refused with `request.csrf`. Empty until the panel and storefront hosts are
 * decided (the D2 ADR): until then only requests without an `Origin` header pass.
 */
const allowedOrigin = z
  .string()
  .max(200)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
    } catch {
      return false;
    }
  }, 'must be an exact origin such as "https://panel.example"');

const timeZone = z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone');
/** A name used as an object key must never be an `Object.prototype` member (`constructor`...). */
const plainName = (schema: z.ZodString) =>
  schema.refine((value) => !(value in Object.prototype), 'must not be an Object.prototype member');
const fieldKey = plainName(
  z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u, 'must be a camelCase field key'),
);
const regionName = plainName(z.string().min(1).max(64));

/**
 * A postcode pattern runs on user input, so it is held to a small grammar: anchored, at most 64
 * characters, no `*` or `+`, no lookaround, named group or back-reference, and every `{}`
 * repeat bounded. With no unbounded repeat a pattern cannot backtrack catastrophically.
 */
const postcodePatternSource = z
  .string()
  .max(64)
  .refine((value) => {
    try {
      new RegExp(value, 'u');
    } catch {
      return false;
    }
    return true;
  }, 'must be a valid regular expression')
  .refine(
    (value) => value.startsWith('^') && value.endsWith('$') && !value.endsWith('\\$'),
    'must be anchored with ^ and $',
  )
  .refine(
    (value) =>
      !/[*+]/u.test(value.replace(/\\./gu, '')) &&
      !/\(\?/u.test(value) &&
      !/\\[1-9k]/u.test(value) &&
      !/\{\d*(,\d*)?\}/u.test(value.replace(/\{\d{1,2}(,\d{1,2})?\}/gu, '')),
    'must use only bounded {n} or {n,m} repeats and no lookaround or back-reference',
  );

/**
 * The `address.format` of the `sellers` section (sellers domain design 4.1 and 4.2): the fields
 * of an address in order, which two of them are the postcode and the region, the postcode
 * pattern and the region list. A Market with other fields needs no migration (data design 3.1).
 */
const addressFormatSchema = z
  .strictObject({
    fields: z
      .array(
        z.strictObject({
          key: fieldKey,
          labelKey: z.string().min(1).max(64),
          required: z.boolean(),
          /** Plaintext limit after NFC (sellers data design Q-M11: 1 to 120). */
          maxLength: z.number().int().min(1).max(120),
        }),
      )
      .min(1)
      .max(12),
    postcodeField: fieldKey,
    /** Absent for a Market whose zone does not depend on a region. */
    regionField: fieldKey.optional(),
    postcodePattern: postcodePatternSource,
    regions: z.array(regionName).max(100),
  })
  .superRefine((format, context) => {
    const keys = format.fields.map((field) => field.key);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({ code: 'custom', message: 'field keys must be unique', path: ['fields'] });
    }
    for (const name of ['postcodeField', 'regionField'] as const) {
      const key = format[name];
      if (key !== undefined && !keys.includes(key)) {
        context.addIssue({ code: 'custom', message: `${name} must name a field`, path: [name] });
      }
    }
    if ((format.regionField === undefined) !== (format.regions.length === 0)) {
      context.addIssue({
        code: 'custom',
        message: 'regionField and a non-empty regions list go together',
        path: ['regions'],
      });
    }
    if (new Set(format.regions).size !== format.regions.length) {
      context.addIssue({ code: 'custom', message: 'regions must be unique', path: ['regions'] });
    }
    const postcode = format.fields.find((field) => field.key === format.postcodeField);
    const region = format.fields.find((field) => field.key === format.regionField);
    if (format.regionField === format.postcodeField) {
      context.addIssue({
        code: 'custom',
        message: 'regionField must differ from postcodeField',
        path: ['regionField'],
      });
    }
    // The zone is derived from these two, so a seller must not be able to leave them out.
    for (const field of [postcode, region]) {
      if (field !== undefined && !field.required) {
        context.addIssue({
          code: 'custom',
          message: `the postcode and region fields must be required (${field.key})`,
          path: ['fields'],
        });
      }
    }
    if (region !== undefined && format.regions.some((name) => name.length > region.maxLength)) {
      context.addIssue({
        code: 'custom',
        message: 'every region must fit the maxLength of the region field',
        path: ['regions'],
      });
    }
  });

/**
 * One region's zones (sellers design 4.1; spike 3 record, mini-review 2026-10-08): the zone a
 * saved address starts with and the closed list the seller may choose from. `default` is a
 * member of `selectable`. A zone must be in the runtime's `Intl` zone list: IANA IDs in the form
 * ICU holds them, so `Etc/*`, offsets, abbreviations and most `backward` links (`Australia/NSW`)
 * are refused. That form is ICU's (CLDR's), not always tzdb's `zone1970.tab` spelling
 * (`Asia/Calcutta` is listed, `Asia/Kolkata` is not on Node 24), so a Market whose zones differ
 * between the two needs a look when the runtime moves. Never an offset (ADR-0005 decision 1).
 */
const regionZonesSchema = z
  .strictObject({
    default: timeZone,
    selectable: z.array(timeZone).min(1).max(20),
  })
  .superRefine((zones, context) => {
    if (!zones.selectable.includes(zones.default)) {
      context.addIssue({
        code: 'custom',
        message: 'default must be one of selectable',
        path: ['default'],
      });
    }
    if (new Set(zones.selectable).size !== zones.selectable.length) {
      context.addIssue({
        code: 'custom',
        message: 'selectable must not repeat a zone',
        path: ['selectable'],
      });
    }
  });

/** The `timezones` of the `sellers` section (design 4.1): region to its zones. */
const sellerTimezonesSchema = z.strictObject({
  /**
   * ISO 3166-1 countries whose zones this Market may list (the Market code is not always a
   * country): boot fails when a listed zone belongs to none of them (guardrail 1).
   */
  countries: z
    .array(z.string().regex(/^[A-Z]{2}$/, 'must be an ISO 3166-1 alpha-2 code'))
    .min(1)
    .max(10),
  byRegion: z.record(regionName, regionZonesSchema),
});

/** The zones the runtime assigns to a country, or none for an unknown code. */
function zonesOfCountry(country: string): readonly string[] {
  // `getTimeZones` is in Node 24's V8 but not in the TypeScript lib this project targets.
  const locale = new Intl.Locale(`und-${country}`) as { getTimeZones?: () => string[] | undefined };
  return locale.getTimeZones?.() ?? [];
}

/**
 * The `sellers` section of a Market file. It starts with what slice 2 (complete details) needs;
 * later slices add the rest of design 4.1 here, each with its own readiness gate (ADR-0013).
 */
const sellersSchema = z
  .strictObject({
    address: addressFormatSchema,
    timezones: sellerTimezonesSchema,
    /**
     * Whether a new seller starts `pending` (true) or `approved` (false) (sellers design 4.1;
     * identity design 3.3, SEL-03, AC 5). Required: a Market never defaults it. It is the seed
     * of the ADR-0026 setting `sellers.approval-required`; `identity` and `sellers` both read
     * it from here until that store lands (sellers slice 15).
     */
    approvalRequired: z.boolean(),
  })
  .superRefine((sellers, context) => {
    const known = new Set<string>();
    sellers.timezones.countries.forEach((country, index) => {
      const zones = zonesOfCountry(country);
      if (zones.length === 0) {
        context.addIssue({
          code: 'custom',
          message: `${country} has no time zones in the runtime zone database`,
          path: ['timezones', 'countries', index],
        });
      }
      zones.forEach((zone) => known.add(zone));
    });
    for (const [region, zones] of Object.entries(sellers.timezones.byRegion)) {
      for (const zone of zones.selectable) {
        if (!known.has(zone)) {
          context.addIssue({
            code: 'custom',
            message: `${zone} does not belong to any of timezones.countries`,
            path: ['timezones', 'byRegion', region, 'selectable'],
          });
        }
      }
    }
    const regions = sellers.address.regions;
    const zoned = Object.keys(sellers.timezones.byRegion);
    const missing = regions.filter((region) => !zoned.includes(region));
    const extra = zoned.filter((region) => !regions.includes(region));
    if (missing.length > 0 || extra.length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          `timezones.byRegion must name exactly the regions of address.regions ` +
          `(missing: ${missing.join(', ') || 'none'}; unknown: ${extra.join(', ') || 'none'})`,
        path: ['timezones', 'byRegion'],
      });
    }
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
    allowedOrigins: z.array(allowedOrigin).max(20),
    identity: identitySchema,
    /** Owned by `sellers`; optional until a Market is configured for sellers. */
    sellers: sellersSchema.optional(),
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
