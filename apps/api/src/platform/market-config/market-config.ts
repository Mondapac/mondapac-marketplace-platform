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

const timeZone = z.string().refine((value) => TIME_ZONES.has(value), 'must be an IANA time zone');
const fieldKey = z.string().regex(/^[a-z][A-Za-z0-9]{0,31}$/u, 'must be a camelCase field key');
const regexSource = z.string().refine((value) => {
  try {
    new RegExp(value, 'u');
    return true;
  } catch {
    return false;
  }
}, 'must be a valid regular expression');

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
          labelKey: z.string().min(1),
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
    postcodePattern: regexSource,
    regions: z.array(z.string().min(1)),
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
  });

/**
 * The `timezones` of the `sellers` section (design 4.1, `TimezoneResolver`): region to IANA zone,
 * with postcodes whose zone differs from their region's. Never an offset (ADR-0005 decision 1).
 */
const sellerTimezonesSchema = z.strictObject({
  byRegion: z.record(z.string().min(1), timeZone),
  /** Exact postcodes or digit ranges ("2880", "2898-2899"); the zone data file of spike 3. */
  postcodeExceptions: z.array(
    z.strictObject({
      postcodes: z
        .array(
          z.string().refine((value) => {
            const entry = value.replace(/\s+/gu, '').toUpperCase();
            if (/^[A-Z0-9]{1,10}$/u.test(entry)) return true;
            // Same grammar as a ServiceArea range: digits only, equal length, low to high.
            const range = /^(\d{1,10})-(\d{1,10})$/u.exec(entry);
            return (
              range !== null && range[1]!.length === range[2]!.length && range[1]! <= range[2]!
            );
          }, 'must be a postcode or a same-length digit range, low to high'),
        )
        .min(1),
      timezone: timeZone,
    }),
  ),
});

/**
 * The `sellers` section of a Market file. It starts with what slice 2 (complete details) needs;
 * later slices add the rest of design 4.1 here, each with its own readiness gate (ADR-0013).
 */
const sellersSchema = z
  .strictObject({ address: addressFormatSchema, timezones: sellerTimezonesSchema })
  .superRefine((sellers, context) => {
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
    markets.set(code, Object.freeze(parsed.data));
  }
  return markets;
}
