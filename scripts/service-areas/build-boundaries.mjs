#!/usr/bin/env node
// Builds config/service-area-boundaries/<MARKET>.json: the outline of each ServiceArea, made from
// the official postal-area shapes of exactly the postcodes the area lists in
// config/service-areas/<MARKET>.json. The storefront's Deliver to map draws it.
//
//   node scripts/service-areas/build-boundaries.mjs AU
//
// Re-run it whenever an area's postcodes change: the API refuses to start when a boundary was
// built from a postcode list that is not the area's current one.
//
// Sources are per Market. AU: Australian Bureau of Statistics, ASGS Edition 3 (2021) Postal Areas
// (POA), CC BY 4.0, from the ABS ArcGIS service. A Market without a source here has no boundary
// file, and its map shows no area outline.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dissolve, simplify } from './boundary-geometry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** About 100 m: the outline is a guide on a map, not a delivery rule (the postcode decides). */
const TOLERANCE_DEGREES = 0.001;
/** Islands and slivers under about 1 km² are left out. */
const MIN_AREA_SQUARE_DEGREES = 0.0001;
/** About 11 m. */
const DECIMALS = 4;

const SOURCES = {
  AU: {
    name: 'ABS ASGS Edition 3 (2021) Postal Areas (POA)',
    licence: 'CC BY 4.0',
    attribution: 'Based on Australian Bureau of Statistics data',
    url: 'https://geo.abs.gov.au/arcgis/rest/services/ASGS2021/POA/MapServer/0',
    field: 'poa_code_2021',
  },
};

/** A postcode entry as the SQL condition of the source's code field ("4000-4179" is a range). */
function condition(field, entry) {
  const value = entry.replace(/\s+/gu, '').toUpperCase();
  if (!/^[A-Z0-9-]+$/u.test(value)) throw new Error(`unexpected postcode entry "${entry}"`);
  const [low, high] = value.split('-');
  return high === undefined
    ? `${field} = '${low}'`
    : `(${field} >= '${low}' AND ${field} <= '${high}')`;
}

async function postalAreas(source, postcodes) {
  const where = postcodes.map((entry) => condition(source.field, entry)).join(' OR ');
  const features = [];
  for (let offset = 0; ;) {
    const query = new URLSearchParams({
      where,
      outFields: source.field,
      outSR: '4326',
      // Rounded once at the source, so the border two postal areas share has the same vertices.
      geometryPrecision: '5',
      returnGeometry: 'true',
      resultOffset: String(offset),
      f: 'geojson',
    });
    const answer = await fetch(`${source.url}/query?${query}`);
    if (!answer.ok) throw new Error(`${source.url} answered ${answer.status}`);
    const page = await answer.json();
    features.push(...page.features);
    if (!page.exceededTransferLimit || page.features.length === 0) break;
    offset += page.features.length;
  }
  return features;
}

async function main() {
  const market = process.argv[2];
  if (!/^[A-Z][A-Z0-9_]{1,7}$/u.test(market ?? '')) {
    throw new Error('usage: build-boundaries.mjs <MARKET>, for example AU');
  }
  const source = SOURCES[market];
  if (source === undefined) throw new Error(`no boundary source for Market ${market}`);
  const config = JSON.parse(
    readFileSync(path.join(ROOT, 'config/service-areas', `${market}.json`), 'utf8'),
  );
  const areas = [];
  for (const area of config.areas) {
    const features = await postalAreas(source, area.postcodes);
    const polygons = features.flatMap(({ geometry }) =>
      geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates,
    );
    const coordinates = simplify(
      dissolve(polygons),
      TOLERANCE_DEGREES,
      MIN_AREA_SQUARE_DEGREES,
      DECIMALS,
    );
    console.log(`${area.code}: ${features.length} postal areas, ${coordinates.length} polygons`);
    areas.push({
      code: area.code,
      postcodes: area.postcodes,
      boundary: { type: 'MultiPolygon', coordinates },
    });
  }
  const { name, licence, attribution, url } = source;
  const file = { market, source: { name, licence, attribution, url }, areas };
  const target = path.join(ROOT, 'config/service-area-boundaries', `${market}.json`);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, formatBoundaryFile(file));
  console.log(`wrote ${path.relative(ROOT, target)}`);
}

/** Readable keys, one line per ring: a full pretty-print would be thousands of lines. */
export function formatBoundaryFile(file) {
  const areas = file.areas.map((area) => {
    const polygons = area.boundary.coordinates
      .map(
        (polygon) =>
          `[\n${polygon.map((ring) => `          ${JSON.stringify(ring)}`).join(',\n')}\n        ]`,
      )
      .join(',\n        ');
    return [
      '    {',
      `      "code": ${JSON.stringify(area.code)},`,
      `      "postcodes": ${JSON.stringify(area.postcodes)},`,
      '      "boundary": {',
      '        "type": "MultiPolygon",',
      `        "coordinates": [\n        ${polygons}\n        ]`,
      '      }',
      '    }',
    ].join('\n');
  });
  return [
    '{',
    `  "market": ${JSON.stringify(file.market)},`,
    `  "source": ${JSON.stringify(file.source, null, 2).replace(/\n/gu, '\n  ')},`,
    `  "areas": [\n${areas.join(',\n')}\n  ]`,
    '}',
    '',
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
