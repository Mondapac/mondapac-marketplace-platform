import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SeededDefinition, SeededFamily } from '../../application/ports/attribute-seed';
import type { SeededCategory } from '../../application/ports/category-seed';

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
  attributes: z.strictObject({ definitions: z.array(definition), families: z.array(family) }),
});

export interface FileCatalogSeeds {
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
  const attributes: Record<
    string,
    {
      readonly definitions: readonly SeededDefinition[];
      readonly families: readonly SeededFamily[];
    }
  > = {};
  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => name.endsWith('.json'));
  } catch {
    return { categories, attributes };
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
    attributes[code] = parsed.data.attributes;
  }
  return { categories, attributes };
}
