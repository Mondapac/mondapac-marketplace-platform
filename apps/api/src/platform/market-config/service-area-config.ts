import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';
import {
  InvalidPostcodeEntryError,
  parsePostcodeEntries,
  postcodesClash,
  type ParsedPostcodes,
} from './postcode-entry';
import {
  ServiceAreaDirectory,
  type CrossAreaSelling,
  type LaneEnd,
  type ServiceAreaDefinition,
} from './service-area-directory';
import { loadServiceAreaBoundaries, type AreaPostcodes } from './service-area-boundaries';
import { InvalidServiceAreaConfigError } from './service-area-errors';

/** Codes from configuration are text, never a closed list (sellers data design S8). */
const AREA_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;

/** A language tag as a key of `names`: "en", "fa", "ar", "en-AU". */
const NAME_LOCALE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/u;

/** Display names per language; English is mandatory (buyer multilingual rule, john 30 Oct 2026). */
const namesSchema = z
  .record(z.string().regex(NAME_LOCALE, 'must be a language tag such as "en" or "fa"'), z.string())
  .superRefine((names, ctx) => {
    for (const [locale, name] of Object.entries(names)) {
      if (name.trim() === '' || name.length > 120) {
        ctx.addIssue({
          code: 'custom',
          message: `name for "${locale}" must be 1 to 120 characters`,
        });
      }
    }
    if (names['en'] === undefined) {
      ctx.addIssue({ code: 'custom', message: 'an English name ("en") is required' });
    }
  });

const areaSchema = z.strictObject({
  code: z.string().regex(AREA_CODE, 'must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  /** The area's display names, one per language; English is required. */
  names: namesSchema,
  /**
   * The Market region (state) the area belongs to, as the address `regionField` writes it
   * ("QLD"). Lets a later rule switch a whole state on by naming the region. Optional: a
   * Market without regions leaves it out.
   */
  region: z
    .string()
    .regex(/^[A-Za-z0-9]{1,8}$/u, 'must be 1 to 8 letters or digits')
    .optional(),
  /** Exact postcodes ("4000", "SW1A 1AA") or digit ranges ("4000-4179", same length). */
  postcodes: z.array(z.string()).min(1),
  sellerOnboardingEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
});

const laneEndSchema = z.union([
  z.strictObject({ area: z.string().regex(AREA_CODE) }),
  z.strictObject({ region: z.string().regex(/^[A-Za-z0-9]{1,8}$/u) }),
  z.strictObject({ all: z.literal(true) }),
]);

/**
 * Cross-area selling (seller city, package 8). `enabled` is the Market switch and is OFF unless
 * it says true; with it off the lanes do nothing and a seller serves only its own area. A lane
 * names where the seller is (`from`) and where the buyer is (`to`), each an area, a region
 * (state) or `all`. No lane means no cross-area selling.
 */
const crossAreaSellingSchema = z.strictObject({
  enabled: z.boolean().default(false),
  lanes: z.array(z.strictObject({ from: laneEndSchema, to: laneEndSchema })).default([]),
});

const fileSchema = z.strictObject({
  market: z.string(),
  areas: z.array(areaSchema),
  crossAreaSelling: crossAreaSellingSchema.optional(),
});

export { InvalidServiceAreaConfigError };

function parsePostcodes(entries: readonly string[], where: string): ParsedPostcodes {
  try {
    return parsePostcodeEntries(entries);
  } catch (error) {
    if (error instanceof InvalidPostcodeEntryError) {
      throw new InvalidServiceAreaConfigError(`${where}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * Reads `<MARKET>.json` for each hosted market from the given directories and builds the
 * directory. Throws on a missing or invalid file, a duplicate code, or a postcode that two
 * areas both claim, so a Region Stack never starts with an ambiguous map. The area outlines
 * come from `boundaryDirectories` (optional per Market, see `loadServiceAreaBoundaries`).
 */
export function loadServiceAreas(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
  boundaryDirectories: readonly string[] = [],
): ServiceAreaDirectory {
  const files = new Map<string, string>();
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      throw new InvalidServiceAreaConfigError(`Service-area directory ${directory} cannot be read`);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidServiceAreaConfigError(`Market "${code}" has service areas twice`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const byMarket = new Map<MarketId, readonly ServiceAreaDefinition[]>();
  const crossArea = new Map<MarketId, CrossAreaSelling>();
  const postcodesByMarket = new Map<MarketId, readonly AreaPostcodes[]>();
  for (const marketId of hostedMarkets) {
    const file = files.get(marketId);
    if (file === undefined) {
      throw new InvalidServiceAreaConfigError(
        `Hosted market "${marketId}" has no service-area file (${marketId}.json)`,
      );
    }
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      throw new InvalidServiceAreaConfigError(`${file} cannot be read`);
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      throw new InvalidServiceAreaConfigError(`${file} is not valid JSON`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
        .join('; ');
      throw new InvalidServiceAreaConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.market !== marketId) {
      throw new InvalidServiceAreaConfigError(
        `${file} declares market "${parsed.data.market}"; it must match the file name`,
      );
    }

    const areas: ServiceAreaDefinition[] = [];
    for (const area of parsed.data.areas) {
      const where = `${file}: area "${area.code}"`;
      if (areas.some((other) => other.code === area.code)) {
        throw new InvalidServiceAreaConfigError(`${where} is listed twice`);
      }
      const postcodes = parsePostcodes(area.postcodes, where);
      for (const other of areas) {
        if (postcodesClash(postcodes, other)) {
          throw new InvalidServiceAreaConfigError(
            `${where} shares a postcode with "${other.code}"`,
          );
        }
      }
      areas.push(
        Object.freeze({
          code: area.code,
          names: Object.freeze({ ...area.names }),
          region: area.region ?? null,
          sellerOnboardingEnabled: area.sellerOnboardingEnabled,
          deliveryEnabled: area.deliveryEnabled,
          intervals: Object.freeze(postcodes.intervals),
          exact: postcodes.exact,
        }),
      );
    }
    byMarket.set(marketId, Object.freeze(areas));
    postcodesByMarket.set(
      marketId,
      parsed.data.areas.map(({ code, postcodes }) => ({ code, postcodes })),
    );
    const rules = parsed.data.crossAreaSelling;
    if (rules !== undefined) {
      const known = (end: LaneEnd): boolean =>
        'all' in end
          ? true
          : 'area' in end
            ? areas.some((area) => area.code === end.area)
            : areas.some((area) => area.region === end.region);
      rules.lanes.forEach((lane, index) => {
        if (!known(lane.from) || !known(lane.to)) {
          throw new InvalidServiceAreaConfigError(
            `${file}: crossAreaSelling lane ${index} names an area or region the Market does not list`,
          );
        }
      });
      crossArea.set(
        marketId,
        Object.freeze({ enabled: rules.enabled, lanes: Object.freeze(rules.lanes) }),
      );
    }
  }
  const boundaries = loadServiceAreaBoundaries(boundaryDirectories, postcodesByMarket);
  return new ServiceAreaDirectory(byMarket, crossArea, boundaries);
}
