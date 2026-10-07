import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';
import {
  normalisePostcode,
  ServiceAreaDirectory,
  type PostcodeInterval,
  type ServiceAreaDefinition,
} from './service-area-directory';

/** Codes from configuration are text, never a closed list (sellers data design S8). */
const AREA_CODE = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const RANGE = /^(\d{1,10})-(\d{1,10})$/u;
const EXACT = /^[A-Z0-9]{1,10}$/u;

const areaSchema = z.strictObject({
  code: z.string().regex(AREA_CODE, 'must match ^[a-z0-9][a-z0-9-]{0,63}$'),
  /** Exact postcodes ("4000", "SW1A 1AA") or digit ranges ("4000-4179", same length). */
  postcodes: z.array(z.string()).min(1),
  sellerOnboardingEnabled: z.boolean(),
  deliveryEnabled: z.boolean(),
});

const fileSchema = z.strictObject({
  market: z.string(),
  areas: z.array(areaSchema),
});

export class InvalidServiceAreaConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidServiceAreaConfigError';
  }
}

interface ParsedPostcodes {
  readonly intervals: PostcodeInterval[];
  readonly exact: Set<string>;
}

function parsePostcodes(entries: readonly string[], where: string): ParsedPostcodes {
  const intervals: PostcodeInterval[] = [];
  const exact = new Set<string>();
  for (const entry of entries) {
    const value = normalisePostcode(entry);
    const range = RANGE.exec(value);
    if (range !== null) {
      const [, from = '', to = ''] = range;
      if (from.length !== to.length || Number(from) > Number(to)) {
        throw new InvalidServiceAreaConfigError(
          `${where}: range "${entry}" must have ends of the same length, low to high`,
        );
      }
      intervals.push({ length: from.length, low: Number(from), high: Number(to) });
    } else if (EXACT.test(value)) {
      if (/^\d+$/u.test(value)) {
        intervals.push({ length: value.length, low: Number(value), high: Number(value) });
      } else {
        exact.add(value);
      }
    } else {
      throw new InvalidServiceAreaConfigError(`${where}: "${entry}" is not a postcode or a range`);
    }
  }
  return { intervals, exact };
}

function overlap(a: PostcodeInterval, b: PostcodeInterval): boolean {
  return a.length === b.length && a.low <= b.high && b.low <= a.high;
}

/**
 * Reads `<MARKET>.json` for each hosted market from the given directories and builds the
 * directory. Throws on a missing or invalid file, a duplicate code, or a postcode that two
 * areas both claim, so a Region Stack never starts with an ambiguous map.
 */
export function loadServiceAreas(
  directories: readonly string[],
  hostedMarkets: readonly MarketId[],
): ServiceAreaDirectory {
  const files = new Map<string, string>();
  for (const directory of directories) {
    for (const name of readdirSync(directory)) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidServiceAreaConfigError(`Market "${code}" has service areas twice`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const byMarket = new Map<MarketId, readonly ServiceAreaDefinition[]>();
  for (const marketId of hostedMarkets) {
    const file = files.get(marketId);
    if (file === undefined) {
      throw new InvalidServiceAreaConfigError(
        `Hosted market "${marketId}" has no service-area file (${marketId}.json)`,
      );
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
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
        const clash =
          [...postcodes.exact].some((value) => other.exact.has(value)) ||
          postcodes.intervals.some((a) => other.intervals.some((b) => overlap(a, b)));
        if (clash) {
          throw new InvalidServiceAreaConfigError(
            `${where} shares a postcode with "${other.code}"`,
          );
        }
      }
      areas.push(
        Object.freeze({
          code: area.code,
          sellerOnboardingEnabled: area.sellerOnboardingEnabled,
          deliveryEnabled: area.deliveryEnabled,
          intervals: Object.freeze(postcodes.intervals),
          exact: postcodes.exact,
        }),
      );
    }
    byMarket.set(marketId, Object.freeze(areas));
  }
  return new ServiceAreaDirectory(byMarket);
}
