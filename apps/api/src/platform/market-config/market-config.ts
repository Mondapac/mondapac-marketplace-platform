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
 * The admin session (identity design 6.1; HF6): at most 30 minutes idle and 12 hours absolute,
 * the ceilings of Hassan's numbers, never persistent (no `keepSignedInSessions.admin` exists).
 */
const adminSessionLifetimeSchema = z
  .strictObject({
    idleTimeoutMinutes: z.number().int().min(1).max(30),
    absoluteLifetimeMinutes: z.number().int().min(1).max(720),
  })
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

/** The origin and the host name of a page URL, or null when it does not parse. */
function hostOf(page: string): { readonly origin: string; readonly hostname: string } | null {
  try {
    const url = new URL(page);
    return { origin: url.origin, hostname: url.hostname };
  } catch {
    return null;
  }
}

/** The admin panel's sign-in pages (slice 7b): all four, or none. */
const ADMIN_SIGN_IN_PAGES = [
  'sign-in',
  'accept-invitation',
  'enrol-second-factor',
  'reset-password',
] as const;

/**
 * The page a mail links to, per population and page (identity design 9, `LinkTargets`). Each
 * population has its own set of pages: `seller-review-queue` exists only for `admin` (identity
 * design 8.7, the reviewer notice; Hassan I1).
 */
const linkTargetsSchema = z
  .strictObject({
    customer: z.strictObject({
      'verify-email': pageUrl,
      'sign-in': pageUrl,
      'reset-password': pageUrl,
    }),
    /** The seller panel's pages (slice 5); absent for a Market without seller sign-up. */
    seller: z
      .strictObject({ 'verify-email': pageUrl, 'sign-in': pageUrl, 'reset-password': pageUrl })
      .optional(),
    /**
     * The admin panel's pages (identity design 8.7). `seller-review-queue` is the "Awaiting
     * review" queue the reviewer notice links to: the queue only, never a seller id or a query
     * built from data (Ali C8, Q6). Required whenever `seller` is present.
     */
    admin: z
      .strictObject({
        'seller-review-queue': pageUrl,
        /**
         * The admin sign-in pages of slice 7b (identity design 6.6, 7.2, 7.3): the four are given
         * together or not at all; without them the Market offers no admin sign-in.
         */
        'sign-in': pageUrl.optional(),
        'accept-invitation': pageUrl.optional(),
        'enrol-second-factor': pageUrl.optional(),
        'reset-password': pageUrl.optional(),
      })
      .optional(),
  })
  .superRefine((targets, context) => {
    if (targets.seller !== undefined && targets.admin === undefined) {
      context.addIssue({
        code: 'custom',
        message: 'admin.seller-review-queue is required when seller targets are configured',
        path: ['admin'],
      });
    }
    if (targets.admin === undefined) return;
    const signInPages = ADMIN_SIGN_IN_PAGES.filter((page) => targets.admin![page] !== undefined);
    if (signInPages.length > 0 && signInPages.length < ADMIN_SIGN_IN_PAGES.length) {
      context.addIssue({
        code: 'custom',
        message: `admin pages ${ADMIN_SIGN_IN_PAGES.join(', ')} are given together or not at all`,
        path: ['admin'],
      });
    }
    // Every admin page is on the origin of the review queue (scheme, host and port; Hassan,
    // PR #157): an admin token is only ever mailed to our own admin panel.
    const queue = hostOf(targets.admin['seller-review-queue']);
    for (const page of ADMIN_SIGN_IN_PAGES) {
      const url = targets.admin[page];
      if (url === undefined || queue === null) continue;
      if (hostOf(url)?.origin !== queue.origin) {
        context.addIssue({
          code: 'custom',
          message: 'an admin page must have the origin of seller-review-queue',
          path: ['admin', page],
        });
      }
    }
    // The admin panel is a host of its own (HF7): a mail must never send an admin to a page on
    // the seller panel or the storefront, nor the other way round (Hassan I1). Origins and host
    // names both: another scheme or port on the same host is the same host (Hassan I-1, R-3).
    const others = [targets.customer, targets.seller]
      .flatMap((pages) => (pages === undefined ? [] : Object.values(pages)))
      .map(hostOf)
      .filter((host) => host !== null);
    const origins = new Set(others.map((host) => host.origin));
    const hostnames = new Set(others.map((host) => host.hostname));
    for (const [page, url] of Object.entries(targets.admin)) {
      if (url === undefined) continue;
      const host = hostOf(url);
      if (host === null) continue;
      if (origins.has(host.origin)) {
        context.addIssue({
          code: 'custom',
          message: 'an admin page must not share its origin with a seller or customer page',
          path: ['admin', page],
        });
      } else if (hostnames.has(host.hostname)) {
        context.addIssue({
          code: 'custom',
          message: 'an admin page must not share its host name with a seller or customer page',
          path: ['admin', page],
        });
      }
    }
  });

/**
 * The identity policy section (identity design 8.5 `IdentityMarketPolicy`; design 15). Each
 * value is Hassan's number (identity design 6.1, 6.5, 6.8; data design 3.6). A slice adds the
 * values it reads: 1d the password rules; slice 2 the customer session lifetime, the sign-in
 * and mail throttles and the retention of sign-in records; slice 3 the links, the retention of
 * unverified accounts and the mail sender; slice 5 the seller lifetimes ("approval required"
 * lives in the `sellers` section); slice 7 the admin lifetime.
 */
const identitySchema = z
  .strictObject({
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
      /** Admin side (6.1: 30 minutes idle, 12 hours absolute; slice 7b). */
      admin: adminSessionLifetimeSchema.optional(),
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
    mailThrottles: z.strictObject({
      account: throttleCounterSchema,
      origin: throttleCounterSchema,
    }),
    /** Sign-in records are deleted this many days after the attempt (H3: 90). */
    signInRecordRetentionDays: z.number().int().min(1).max(3650),
    /**
     * One-time links (identity design 6.6, 9; slices 3 and 4). `lifetimeMinutes` per purpose,
     * from the issue (HF15: verification 24 hours; SEL-05 and ACC-04: a reset link exactly 60
     * minutes, in every Market); a purpose without one is never issued. `targets`: the page a mail
     * links to, per population and page (`LinkTargets`; hosts wait for D2).
     */
    links: z.strictObject({
      lifetimeMinutes: z.strictObject({
        // Hassan L3: a verification link lives at most 24 hours (identity design 6.6).
        'verify-email': z.number().int().min(1).max(1440),
        // SEL-05, ACC-04: "exactly 60 minutes", the same rule in every Market (slice 4).
        'reset-password': z.literal(60),
        // Slice 7b: the admin's enrolment link, at most 60 minutes (identity design 6.6).
        'enrol-second-factor': z.number().int().min(1).max(60).optional(),
      }),
      targets: linkTargetsSchema,
    }),
    /**
     * Invitations (identity design 3.4, 6.6; slice 7b): the lifetime per kind from the dispatch,
     * and the age at which a never-dispatched one is purged (Ali's ruling 4). HF15: an admin
     * invitation lives at most 72 hours, the others at most 7 days. A kind without one is never
     * issued.
     */
    invitations: z
      .strictObject({
        lifetimeMinutes: z.strictObject({
          admin: z
            .number()
            .int()
            .min(1)
            .max(72 * 60)
            .optional(),
          'seller-owner': z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 60)
            .optional(),
          staff: z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 60)
            .optional(),
        }),
      })
      .optional(),
    /**
     * The sign-in challenge of the code step (identity design 2.1, 6.8; slice 7b): at most 5 code
     * checks and 5 minutes.
     */
    challenges: z
      .strictObject({
        maxAttempts: z.number().int().min(1).max(5),
        lifetimeSeconds: z.number().int().min(30).max(300),
      })
      .optional(),
    /**
     * The `second-factor.account` counter (identity design 6.8, HF2; slice 7b): at most 10 failed
     * codes in a window of at least 24 hours, then a block of at least 24 hours (never 0: the block
     * is the lock), both at most 7 days.
     */
    secondFactorThrottles: z
      .strictObject({
        account: z.strictObject({
          limit: z.number().int().min(1).max(10),
          windowMinutes: z
            .number()
            .int()
            .min(24 * 60)
            .max(7 * 24 * 60),
          blockMinutes: z
            .number()
            .int()
            .min(24 * 60)
            .max(7 * 24 * 60),
        }),
      })
      .optional(),
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
  })
  .superRefine((identity, context) => {
    // 1-B (Hassan, PR #157): "keep me signed in" lasts longer than the default seller session, so
    // a kept session is always told apart from a default one by its lifetime.
    const kept = identity.keepSignedInSessions.seller;
    const standard = identity.sessions.seller;
    if (
      kept !== undefined &&
      standard !== undefined &&
      kept.absoluteLifetimeMinutes <= standard.absoluteLifetimeMinutes
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'keepSignedInSessions.seller.absoluteLifetimeMinutes must be greater than sessions.seller.absoluteLifetimeMinutes',
        path: ['keepSignedInSessions', 'seller', 'absoluteLifetimeMinutes'],
      });
    }
    // Admin sign-in is configured whole or not at all (slice 7b): an admin session needs the
    // challenge, the second-factor counter, the enrolment link and the admin pages.
    if (identity.sessions.admin !== undefined) {
      const missing = [
        identity.challenges === undefined ? 'challenges' : null,
        identity.secondFactorThrottles === undefined ? 'secondFactorThrottles' : null,
        identity.links.lifetimeMinutes['enrol-second-factor'] === undefined
          ? 'links.lifetimeMinutes.enrol-second-factor'
          : null,
        identity.links.targets.admin?.['sign-in'] === undefined
          ? 'links.targets.admin.sign-in'
          : null,
        identity.invitations?.lifetimeMinutes.admin === undefined
          ? 'invitations.lifetimeMinutes.admin'
          : null,
      ].filter((key) => key !== null);
      if (missing.length > 0) {
        context.addIssue({
          code: 'custom',
          message: `sessions.admin needs ${missing.join(', ')}`,
          path: ['sessions', 'admin'],
        });
      }
    }
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

/** A reserved slug or claim word as a slug token (sellers design 3.5): lower-case a-z and 0-9. */
const reservedToken = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be lower-case letters, digits and single hyphens')
  .max(50);

/**
 * The reserved words of a Market (sellers design 3.5; Ali change 3): checked-in data, never
 * literals in the module. `slugs` are whole slugs never held (site routes, platform names);
 * `claimWords` are matched per token in a slug (refused) and in a store name (reviewer flag),
 * until `certification` supplies the claim group through a port (design 16.2 item 6).
 */
const reservedWordsSchema = z.strictObject({
  slugs: z
    .array(reservedToken)
    .max(500)
    .refine((list) => new Set(list).size === list.length, 'must not repeat an entry'),
  // No hyphen: a claim word is matched against one token, so a hyphenated entry could never
  // match. At least one, so a Market file cannot quietly switch the claim check off.
  claimWords: z
    .array(
      z
        .string()
        .regex(/^[a-z]+$/, 'must be lower-case letters only (no digit, no hyphen)')
        .max(50),
    )
    .min(1)
    .max(200)
    .refine((list) => new Set(list).size === list.length, 'must not repeat an entry'),
});

/**
 * The `businessIdentifier` of the `sellers` section (sellers design 4.1 and 4.2): which identifier
 * scheme the Market uses, whether a seller must give one, and the translation key of its label.
 * `scheme` names an adapter in `sellers/infrastructure/identifier-schemes/` (a file per scheme);
 * that the name is a known adapter is checked by `sellers` at start-up, not here, because the
 * platform does not know the module's adapters. The register-lookup keys (`registerLookup.*`)
 * join in slice 4a.
 */
const businessIdentifierSchema = z.strictObject({
  scheme: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lower-case scheme token such as "abc-no"'),
  /** Required: a Market never defaults it (design 4.1; AC 5, AC 12). */
  required: z.boolean(),
  labelKey: z.string().min(1).max(64),
});

/**
 * The `sellers` section of a Market file. It starts with what slice 2 (complete details) needs;
 * later slices add the rest of design 4.1 here, each with its own readiness gate (ADR-0013).
 */
const sellersSchema = z
  .strictObject({
    address: addressFormatSchema,
    timezones: sellerTimezonesSchema,
    reservedWords: reservedWordsSchema,
    /** Required: a Market never defaults its identifier scheme (sellers slice 3). */
    businessIdentifier: businessIdentifierSchema,
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

/**
 * The `inventory` section of a Market file (inventory design 8; docs/design/data/inventory.md
 * 8.3). It starts with what slice 1 needs; later slices add the reservation duration, the
 * default low-stock threshold and the default per-customer cap here.
 */
const inventorySchema = z.strictObject({
  /**
   * The most sources (stock locations) one seller may have, the Default included (design 3.4;
   * AU 4). Required: a Market never defaults it. At most 4, because the re-key of a moved Offer
   * locks every stock item of up to `catalog.maxVariantsPerProduct` (AU 100) variants, in every
   * source, on both keys in one statement capped at 1,000 items (design 3.6 step 2, 4.4):
   * 100 x 4 x 2 = 800 plus held items. Raising the limit is a design change with a re-check.
   */
  maxSourcesPerSeller: z.number().int().min(1).max(4),
});

/**
 * The `pricing` section of a Market file (pricing design 4.6, 15; Ali A2: a value only pricing
 * reads lives in pricing's own section). `createPricingPolicy` re-validates every value at
 * start-up for every hosted Market; the shapes here only reject what cannot be a policy.
 * No value has a default.
 */
const pricingSchema = z.strictObject({
  /** The most one unit may cost, in minor units of the Market currency (brief Q10; AU 500000). */
  maxUnitPriceMinor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  /**
   * The jump-hold threshold T = numerator / denominator, an exact fraction (ADR-0007 decision 2;
   * AU 1/2). A change of more than T against the anchor goes to review.
   */
  jumpThreshold: z
    .strictObject({
      numerator: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
      denominator: z
        .number()
        .int()
        .min(1)
        .max(2 ** 31),
    })
    .refine((fraction) => fraction.numerator <= fraction.denominator, {
      message: 'the threshold must not exceed 1',
    }),
  /** Which moves the hold applies to (Q9; AU both). */
  jumpDirections: z.enum(['up', 'down', 'both']),
  /** The jump window W, an ISO 8601 duration of days, hours and minutes (Q1; AU P7D). */
  jumpWindow: z.string().regex(/^P(?!$)(?!T$)(\d{1,3}D)?(T(\d{1,4}H)?(\d{1,5}M)?)?$/u),
});

/**
 * The `catalog` section of a Market file (catalog design 7.1). It starts with what slice 4 needs;
 * later slices add the conditions, review reasons, photo limits and the rest of 7.1.
 */
const catalogSchema = z
  .strictObject({
    /**
     * The tax categories a product may carry (catalog design 4.2): a code and a label key. At
     * least one; no code repeated. The AU codes wait for the tax adviser (ADR-0007 decision 5).
     */
    taxCategories: z
      .array(
        z.strictObject({
          code: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/),
          labelKey: z.string().min(1).max(100),
        }),
      )
      .min(1)
      .max(20),
    /**
     * Which changes to a published product go to review (catalog design 4.3). Every flag is
     * required: a Market never defaults one. `anyImage` must be `true`: an added or
     * replaced image always goes to review (Hassan H1), so the file cannot claim otherwise.
     */
    sensitiveChanges: z.strictObject({
      platformCategories: z.boolean(),
      taxCategory: z.boolean(),
      name: z.boolean(),
      primaryImage: z.boolean(),
      anyImage: z.literal(true),
      variantRemoved: z.boolean(),
    }),
    /**
     * The most non-retired variants one product may hold (catalog design 2.1; AU 100). Bounded
     * above because the re-key of a moved Offer locks that many variants in every source
     * (inventory design 3.6): 100 x 4 x 2 = 800 stays under the 1,000-item cap with held items.
     */
    maxVariantsPerProduct: z.number().int().min(1).max(100),
    /**
     * Whether a new product revision waits for review (true) or publishes at once when the
     * change is minor (false) (catalog design 4.2 row 1). The interim home of the ADR-0026
     * setting `catalog.approval-required` until that store lands (catalog slice 10).
     */
    approvalRequired: z.boolean(),
  })
  .superRefine((catalog, context) => {
    const seen = new Set<string>();
    catalog.taxCategories.forEach((category, index) => {
      if (seen.has(category.code)) {
        context.addIssue({
          code: 'custom',
          path: ['taxCategories', index, 'code'],
          message: 'a tax category code must not repeat',
        });
      }
      seen.add(category.code);
    });
  });

const marketSchema = z
  .strictObject({
    code: marketCode,
    status: z.enum(['planned', 'soft_launch', 'active', 'suspended']),
    defaultLocale: locale,
    supportedLocales: z.array(locale).min(1),
    defaultCurrency: currency,
    settlementCurrency: currency,
    /**
     * The Market's price display convention (ADR-0007 decision 4): true when prices are entered
     * and shown tax-inclusive (AU). Read by pricing, cart, tax, storefront and invoices, so it is
     * platform configuration (pricing design 4.5; Ali A2). Required: a Market never defaults it.
     */
    pricesIncludeTax: z.boolean(),
    /**
     * The most units of one Offer in a cart line, and the ceiling of an Offer's per-customer
     * cap (inventory design 3.3, cart design 4; AU 99; Ali A2). Required, whole, 1 to 999.
     */
    maxLineQuantity: z.number().int().min(1).max(999),
    /** Fallback only (ADR-0005): sellers, locations and addresses carry their own zone. */
    timezone: z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone'),
    requestLimits: requestLimitsSchema,
    allowedOrigins: z.array(allowedOrigin).max(20),
    identity: identitySchema,
    /** Owned by `sellers`; optional until a Market is configured for sellers. */
    sellers: sellersSchema.optional(),
    /** Owned by `inventory`; optional here, checked for every hosted Market at start-up by it. */
    inventory: inventorySchema.optional(),
    /** Owned by `catalog`; optional here, checked for every hosted Market at start-up by it. */
    catalog: catalogSchema.optional(),
    /** Owned by `pricing`; optional here, checked for every hosted Market at start-up by it. */
    pricing: pricingSchema.optional(),
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
