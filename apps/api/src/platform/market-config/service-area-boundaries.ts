import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { MarketId } from '@mondapac/shared-kernel';
import { z } from 'zod';
import { InvalidServiceAreaConfigError } from './service-area-errors';

/** A GeoJSON MultiPolygon in WGS 84 degrees: polygons of rings of [longitude, latitude]. */
export interface AreaBoundary {
  readonly type: 'MultiPolygon';
  readonly coordinates: readonly (readonly (readonly (readonly [number, number])[])[])[];
}

/** Who made the shapes; the storefront shows it next to the map (CC BY needs credit). */
export interface BoundarySource {
  readonly name: string;
  readonly licence: string;
  readonly attribution: string;
}

/** The boundaries of one Market, by area code, and their source. */
export interface MarketBoundaries {
  readonly source: BoundarySource;
  readonly byArea: ReadonlyMap<string, AreaBoundary>;
}

/** A browser draws every point on each open of the map; this keeps the answer small. */
const MAX_POINTS = 20_000;

const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

const ring = z
  .array(position)
  .min(4)
  .refine(
    (points) => {
      const first = points[0]!;
      const last = points[points.length - 1]!;
      return first[0] === last[0] && first[1] === last[1];
    },
    { message: 'a ring must end at its first point' },
  );

const boundarySchema = z.strictObject({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(ring).min(1)).min(1),
});

const fileSchema = z.strictObject({
  market: z.string(),
  source: z.strictObject({
    name: z.string().min(1).max(200),
    licence: z.string().min(1).max(100),
    attribution: z.string().min(1).max(200),
    url: z.url().optional(),
  }),
  areas: z.array(
    z.strictObject({
      code: z.string(),
      /** The area's `postcodes` the shape was built from, exactly as config/service-areas lists them. */
      postcodes: z.array(z.string()).min(1),
      boundary: boundarySchema,
    }),
  ),
});

/** The areas of a Market as the boundary check needs them: code and configured postcode list. */
export interface AreaPostcodes {
  readonly code: string;
  readonly postcodes: readonly string[];
}

/**
 * Reads `<MARKET>.json` from the boundary directories (config/service-area-boundaries, built by
 * scripts/service-areas/build-boundaries.mjs). A Market without a file has no boundaries: its map
 * shows no outline, and nothing else changes. A file that is invalid, names an area the Market
 * does not list, or was built from another postcode list than the area's current one stops the
 * boot, so a stale shape is never drawn.
 */
export function loadServiceAreaBoundaries(
  directories: readonly string[],
  areasByMarket: ReadonlyMap<MarketId, readonly AreaPostcodes[]>,
): ReadonlyMap<MarketId, MarketBoundaries> {
  const files = new Map<string, string>();
  for (const directory of directories) {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      throw new InvalidServiceAreaConfigError(`Boundary directory ${directory} cannot be read`);
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const code = path.basename(name, '.json');
      if (files.has(code)) {
        throw new InvalidServiceAreaConfigError(`Market "${code}" has boundaries twice`);
      }
      files.set(code, path.join(directory, name));
    }
  }

  const result = new Map<MarketId, MarketBoundaries>();
  for (const [marketId, areas] of areasByMarket) {
    const file = files.get(marketId);
    if (file === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      throw new InvalidServiceAreaConfigError(`${file} cannot be read as JSON`);
    }
    const parsed = fileSchema.safeParse(raw);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || 'file'}: ${issue.message}`)
        .join('; ');
      throw new InvalidServiceAreaConfigError(`${file} is invalid: ${issues}`);
    }
    if (parsed.data.market !== marketId) {
      throw new InvalidServiceAreaConfigError(
        `${file} declares market "${parsed.data.market}"; it must match the file name`,
      );
    }
    const byArea = new Map<string, AreaBoundary>();
    let points = 0;
    for (const entry of parsed.data.areas) {
      const where = `${file}: area "${entry.code}"`;
      const area = areas.find((candidate) => candidate.code === entry.code);
      if (area === undefined) {
        throw new InvalidServiceAreaConfigError(`${where} is not a service area of ${marketId}`);
      }
      if (byArea.has(entry.code)) {
        throw new InvalidServiceAreaConfigError(`${where} is listed twice`);
      }
      if (
        area.postcodes.length !== entry.postcodes.length ||
        area.postcodes.some((value, index) => value !== entry.postcodes[index])
      ) {
        throw new InvalidServiceAreaConfigError(
          `${where} was built from other postcodes than the area lists now; ` +
            'rebuild it with scripts/service-areas/build-boundaries.mjs',
        );
      }
      for (const polygon of entry.boundary.coordinates) {
        for (const line of polygon) points += line.length;
      }
      byArea.set(entry.code, freeze(entry.boundary));
    }
    if (points > MAX_POINTS) {
      throw new InvalidServiceAreaConfigError(
        `${file} has ${points} points; at most ${MAX_POINTS} (simplify the shapes)`,
      );
    }
    const { name, licence, attribution } = parsed.data.source;
    result.set(
      marketId,
      Object.freeze({ source: Object.freeze({ name, licence, attribution }), byArea }),
    );
  }
  return result;
}

function freeze(boundary: z.infer<typeof boundarySchema>): AreaBoundary {
  return Object.freeze({
    type: 'MultiPolygon' as const,
    coordinates: Object.freeze(
      boundary.coordinates.map((polygon) =>
        Object.freeze(
          polygon.map((line) =>
            Object.freeze(line.map(([lng, lat]) => Object.freeze([lng, lat] as const))),
          ),
        ),
      ),
    ),
  });
}
