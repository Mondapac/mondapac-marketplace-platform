import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { MEASURE_DIMENSIONS } from '@mondapac/shared-kernel';
import { z } from 'zod';
import type { SeededDefinition, SeededFamily } from '../../application/ports/attribute-seed';
import type { SeededCategory } from '../../application/ports/category-seed';
import type { SeededCulture } from '../../application/ports/culture-seed';

/**
 * The directory of the per-Market catalog seeds (`config/catalog-seed/<MARKET>.json`): Market
 * data, so the Market's identifiers live in a configuration file and not in core code
 * (ADR-0003 decision 2).
 */
export const DEFAULT_CATALOG_SEED_DIR = path.resolve(
  __dirname,
  '../../../../../../../config/catalog-seed',
);

const text = z.string().min(1).max(512);
const localized = z.record(z.string(), text);
const category = z.strictObject({
  slug: text,
  parentSlug: text.nullable(),
  verticalRootCode: text.nullable(),
  names: z.array(z.strictObject({ locale: text, name: text })).min(1),
});
const culture = z.strictObject({
  code: text,
  displayOrder: z.number().int(),
  requiredCertificationType: text.nullable(),
  badgeColour: text.nullable(),
  isDefault: z.boolean(),
  names: z.array(z.strictObject({ locale: text, name: text, description: text.nullable() })),
});
const definition = z.strictObject({
  code: text,
  dataType: text,
  localizable: z.boolean(),
  material: z.boolean(),
  isVariantOption: z.boolean(),
  bounds: z.strictObject({
    maxLength: z.number().int().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    measure: z
      .strictObject({
        dimension: z.enum(MEASURE_DIMENSIONS),
        units: z.array(text),
        defaultUnit: text,
        decimals: z.number().int(),
      })
      .optional(),
  }),
  names: localized,
  options: z.array(
    z.strictObject({
      code: text,
      labels: localized,
      active: z.boolean(),
      position: z.number().int(),
    }),
  ),
});
const family = z.strictObject({
  code: text,
  groups: z.array(
    z.strictObject({
      groupCode: text,
      attributes: z.array(
        z.strictObject({ code: text, required: z.boolean(), isVariantOption: z.boolean() }),
      ),
    }),
  ),
});
const file = z.strictObject({
  market: z.string().regex(/^[A-Z][A-Z0-9_]{1,7}$/),
  note: z.string().optional(),
  categories: z.array(category),
  cultures: z.array(culture).default([]),
  attributes: z.strictObject({ definitions: z.array(definition), families: z.array(family) }),
});

export interface FileCatalogSeeds {
  readonly cultures: Readonly<Record<string, readonly SeededCulture[]>>;
  readonly categories: Readonly<Record<string, readonly SeededCategory[]>>;
  readonly attributes: Readonly<
    Record<
      string,
      {
        readonly definitions: readonly SeededDefinition[];
        readonly families: readonly SeededFamily[];
      }
    >
  >;
}

/** A seed file that is unreadable, malformed or named for another Market: the start-up stops. */
export class CatalogSeedFileError extends Error {}

/**
 * Reads every `<MARKET>.json` of the directory. A missing directory is an empty set; a bad file
 * throws, so a seed with a mistake fails loudly at boot and in the unit test (design 7.2).
 */
export function loadFileCatalogSeeds(
  directory: string = DEFAULT_CATALOG_SEED_DIR,
): FileCatalogSeeds {
  const categories: Record<string, readonly SeededCategory[]> = {};
  const cultures: Record<string, readonly SeededCulture[]> = {};
  const attributes: Record<
    string,
    {
      readonly definitions: readonly SeededDefinition[];
      readonly families: readonly SeededFamily[];
    }
  > = {};
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => /^[A-Z][A-Z0-9_]{1,7}\.json$/.test(name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      return { categories, cultures, attributes };
    throw error;
  }
  for (const name of names.sort()) {
    const code = name.slice(0, -'.json'.length);
    let parsed: z.ZodSafeParseResult<z.infer<typeof file>>;
    try {
      parsed = file.safeParse(JSON.parse(readFileSync(path.join(directory, name), 'utf8')));
    } catch {
      throw new CatalogSeedFileError(`Catalog seed file ${name} cannot be read as JSON`);
    }
    if (!parsed.success || parsed.data.market !== code) {
      throw new CatalogSeedFileError(`Catalog seed file ${name} is invalid or not for ${code}`);
    }
    categories[code] = parsed.data.categories;
    cultures[code] = parsed.data.cultures;
    attributes[code] = parsed.data.attributes;
  }
  return { categories, cultures, attributes };
}
