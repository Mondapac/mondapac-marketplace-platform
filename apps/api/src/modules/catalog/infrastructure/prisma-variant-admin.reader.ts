import { Logger } from '@nestjs/common';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  VariantAdminReader,
  VariantIssue,
  VariantRow,
  VariantsPage,
  VariantsQuery,
  VariantTypeFeatureSet,
  VariantTypeRecord,
} from '../application/ports/variant-admin.reader';
import { variantCodeOf } from '../domain/product';
import {
  DEFAULT_VARIANT_TYPE_SETTINGS,
  type VariantDisplayStyle,
  type VariantOptionOrder,
  type VariantTypeSettingsContent,
} from '../domain/variant-type-settings';
import { asTexts } from './locale-pick';

/** The most duplicate GTINs the "Duplicate GTIN" filter follows; more is a data problem to fix. */
export const DUPLICATE_GTIN_SCAN = 1000;
/** The most feature sets read to say which offer a variant type. */
const FEATURE_SET_SCAN = 500;

type VariantWhere = Prisma.CatalogProductRevisionVariantWhereInput;

/** Escapes `\`, `%` and `_`, so a search term is matched as typed (LIKE patterns). */
const literal = (term: string): string => term.replace(/[\\%_]/g, (char) => `\\${char}`);

const stringMap = (value: unknown): Record<string, string> => {
  const map = asTexts(value) ?? {};
  return Object.fromEntries(
    Object.entries(map).filter(([, text]) => typeof text === 'string' && text !== ''),
  );
};

/** A variant of the published revision of a live product (published; a paused one included). */
const liveOf = (market: MarketContext): VariantWhere => ({
  marketId: market.marketId,
  revision: {
    is: { publishedOf: { some: { marketId: market.marketId, status: 'published' } } },
  },
});

/**
 * The variant's label lacks one of these locales: an absent key, a JSON null or an empty text (as
 * the row's `missingLocales` counts them).
 */
const missingLocale = (locales: readonly string[]): VariantWhere => ({
  OR: locales.flatMap((locale): VariantWhere[] => [
    { NOT: { labels: { path: [locale], not: Prisma.AnyNull } } },
    { labels: { path: [locale], equals: '' } },
  ]),
});

const VARIANT_CODE = /^(.+)-(\d{2,})$/;

function textWhere(text: string, locale: string): VariantWhere {
  const part = literal(text);
  const or: VariantWhere[] = [
    {
      revision: {
        is: { product: { is: { productCode: { contains: part, mode: 'insensitive' } } } },
      },
    },
    {
      revision: {
        is: { texts: { some: { locale, name: { contains: part, mode: 'insensitive' } } } },
      },
    },
    {
      revision: {
        is: {
          product: {
            is: {
              offers: { some: { status: { not: 'deleted' }, sellerSku: { contains: part } } },
            },
          },
        },
      },
    },
  ];
  const code = VARIANT_CODE.exec(text);
  if (code !== null) {
    or.push({
      variant: {
        is: {
          variantNo: Number(code[2]),
          product: { is: { productCode: { equals: code[1]!, mode: 'insensitive' } } },
        },
      },
    });
  }
  const digits = text.replace(/[\s-]/g, '');
  if (/^\d{3,14}$/.test(digits)) or.push({ gtin: { contains: digits } });
  return { OR: or };
}

function issueWhere(
  issue: VariantIssue,
  locales: readonly string[],
  duplicates: readonly string[],
): VariantWhere {
  switch (issue) {
    case 'no-seller-selling':
      return { revision: { is: { product: { is: { offers: { none: { listed: true } } } } } } };
    case 'missing-gtin':
      return { gtin: null };
    case 'duplicate-gtin':
      return { gtin: { in: [...duplicates] } };
    case 'no-image':
      return { imageIds: { isEmpty: true }, revision: { is: { images: { none: {} } } } };
    case 'missing-language':
      return missingLocale(locales);
  }
}

const typeWhere = (code: string): VariantWhere => ({
  optionValues: { path: [code], not: Prisma.AnyNull },
});

/**
 * {@link VariantAdminReader} on `catalog.attribute_definitions` and their revisions and options,
 * the variant type settings, the families, `product_revision_variants` of published revisions,
 * `products` and `offers`. Every statement goes through
 * `PrismaService.tx(market)` with `marketId` at the top level of `where`. Read only; no join
 * outside catalog.
 */
export class PrismaVariantAdminReader implements VariantAdminReader {
  readonly #logger = new Logger('PrismaVariantAdminReader');

  constructor(private readonly prisma: PrismaService) {}

  async variantTypes(market: MarketContext, limit: number): Promise<readonly VariantTypeRecord[]> {
    const rows = await this.prisma.tx(market).catalogAttributeDefinition.findMany({
      where: {
        marketId: market.marketId,
        status: { in: ['draft', 'active'] },
        publishedRevision: { is: { isVariantOption: true } },
      },
      include: TYPE_INCLUDE,
      orderBy: [{ code: 'asc' }],
      take: limit,
    });
    return rows.flatMap((row) => {
      const record = typeOf(row);
      return record === null ? [] : [record];
    });
  }

  async variantType(
    market: MarketContext,
    id: Id<'AttributeDefinition'>,
  ): Promise<VariantTypeRecord | null> {
    const row = await this.prisma.tx(market).catalogAttributeDefinition.findFirst({
      where: {
        marketId: market.marketId,
        id,
        status: { in: ['draft', 'active'] },
        publishedRevision: { is: { isVariantOption: true } },
      },
      include: TYPE_INCLUDE,
    });
    return row === null ? null : typeOf(row);
  }

  async typeCounts(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly products: number; readonly liveVariants: number }>> {
    const tx = this.prisma.tx(market);
    const counts = new Map<string, { products: number; liveVariants: number }>();
    for (const code of codes) {
      const [products, liveVariants] = await Promise.all([
        tx.catalogProduct.count({
          where: {
            marketId: market.marketId,
            status: 'published',
            publishedRevision: { is: { variants: { some: typeWhere(code) } } },
          },
        }),
        tx.catalogProductRevisionVariant.count({
          where: { marketId: market.marketId, AND: [liveOf(market), typeWhere(code)] },
        }),
      ]);
      counts.set(code, { products, liveVariants });
    }
    return counts;
  }

  async optionProductCounts(
    market: MarketContext,
    code: string,
    optionCodes: readonly string[],
  ): Promise<ReadonlyMap<string, number>> {
    const tx = this.prisma.tx(market);
    const counts = new Map<string, number>();
    for (const optionCode of optionCodes) {
      counts.set(
        optionCode,
        await tx.catalogProduct.count({
          where: {
            marketId: market.marketId,
            status: 'published',
            publishedRevision: {
              is: { variants: { some: { optionValues: { path: [code], equals: optionCode } } } },
            },
          },
        }),
      );
    }
    return counts;
  }

  async featureSetsUsing(
    market: MarketContext,
    codes: readonly string[],
  ): Promise<ReadonlyMap<string, readonly VariantTypeFeatureSet[]>> {
    const result = new Map<string, VariantTypeFeatureSet[]>(codes.map((code) => [code, []]));
    if (codes.length === 0) return result;
    const families = await this.prisma.tx(market).catalogAttributeFamily.findMany({
      where: { marketId: market.marketId, status: 'active', publishedRevisionId: { not: null } },
      select: {
        id: true,
        code: true,
        publishedRevision: { select: { names: true, groups: true } },
      },
      orderBy: [{ code: 'asc' }],
      take: FEATURE_SET_SCAN,
    });
    if (families.length >= FEATURE_SET_SCAN) {
      this.#logger.warn({
        msg: 'catalog.variant-admin.feature-set-cap',
        marketId: market.marketId,
        cap: FEATURE_SET_SCAN,
      });
    }
    for (const family of families) {
      const revision = family.publishedRevision;
      if (revision === null) continue;
      const offered = new Set(variantCodesOf(revision.groups).filter((code) => result.has(code)));
      for (const code of offered) {
        result.get(code)!.push({
          id: family.id as Id<'AttributeFamily'>,
          code: family.code,
          names: stringMap(revision.names),
        });
      }
    }
    return result;
  }

  async variantsPage(market: MarketContext, query: VariantsQuery): Promise<VariantsPage> {
    const tx = this.prisma.tx(market);
    const where = await this.#where(market, query);
    const rows = await tx.catalogProductRevisionVariant.findMany({
      where: {
        marketId: market.marketId,
        AND: [where, ...(query.after === null ? [] : [{ variantId: { lt: query.after } }])],
      },
      orderBy: { variantId: 'desc' },
      take: query.limit + 1,
      select: {
        variantId: true,
        productId: true,
        labels: true,
        gtin: true,
        imageIds: true,
        variant: { select: { variantNo: true } },
        revision: {
          select: {
            texts: { where: { locale: query.locale }, select: { name: true } },
            _count: { select: { images: true } },
            product: {
              select: {
                productCode: true,
                scope: true,
                pausedAt: true,
                _count: { select: { offers: { where: { listed: true } } } },
              },
            },
          },
        },
      },
    });
    const page = rows.slice(0, query.limit);
    const nextAfter = rows.length > query.limit ? page[page.length - 1]!.variantId : null;
    if (page.length === 0) return { rows: [], nextAfter: null };

    const gtins = [...new Set(page.flatMap((row) => (row.gtin === null ? [] : [row.gtin])))];
    const duplicated =
      gtins.length === 0
        ? []
        : await tx.catalogProductRevisionVariant.groupBy({
            by: ['gtin'],
            where: { marketId: market.marketId, AND: [liveOf(market), { gtin: { in: gtins } }] },
            having: { gtin: { _count: { gt: 1 } } },
          });
    const duplicates = new Set(duplicated.map((group) => group.gtin));

    return {
      nextAfter,
      rows: page.map((row): VariantRow => {
        const labels = stringMap(row.labels);
        const product = row.revision.product;
        return {
          productId: row.productId as Id<'Product'>,
          productCode: product.productCode,
          productName: row.revision.texts[0]?.name ?? null,
          productScope: product.scope === 'PLATFORM' ? 'PLATFORM' : 'SELLER',
          productPaused: product.pausedAt !== null,
          variantId: row.variantId as Id<'Variant'>,
          variantNo: row.variant.variantNo,
          variantCode: variantCodeOf(product.productCode, row.variant.variantNo),
          labels,
          gtin: row.gtin,
          duplicateGtin: row.gtin !== null && duplicates.has(row.gtin),
          sellers: product._count.offers,
          ownImages: row.imageIds.length,
          productImages: row.revision._count.images,
          missingLocales: query.locales.filter((locale) => !labels[locale]),
        };
      }),
    };
  }

  async issueCounts(
    market: MarketContext,
    query: Pick<VariantsQuery, 'typeCode' | 'locales'>,
  ): Promise<Readonly<Record<VariantIssue, number>>> {
    const tx = this.prisma.tx(market);
    const base: VariantWhere[] = [liveOf(market)];
    if (query.typeCode !== null) base.push(typeWhere(query.typeCode));
    const duplicates = await this.#duplicateGtins(market);
    const count = (issue: VariantIssue) =>
      tx.catalogProductRevisionVariant.count({
        where: {
          marketId: market.marketId,
          AND: [...base, issueWhere(issue, query.locales, duplicates)],
        },
      });
    const [none, missing, duplicate, image, language] = await Promise.all([
      count('no-seller-selling'),
      count('missing-gtin'),
      count('duplicate-gtin'),
      count('no-image'),
      count('missing-language'),
    ]);
    return {
      'no-seller-selling': none,
      'missing-gtin': missing,
      'duplicate-gtin': duplicate,
      'no-image': image,
      'missing-language': language,
    };
  }

  async #where(market: MarketContext, query: VariantsQuery): Promise<VariantWhere> {
    const and: VariantWhere[] = [liveOf(market)];
    if (query.typeCode !== null) and.push(typeWhere(query.typeCode));
    if (query.text !== null) and.push(textWhere(query.text, query.locale));
    if (query.issue !== null) {
      const duplicates = query.issue === 'duplicate-gtin' ? await this.#duplicateGtins(market) : [];
      and.push(issueWhere(query.issue, query.locales, duplicates));
    }
    return { AND: and };
  }

  /**
   * The GTINs that more than one live variant carries (the duplicate check counts every live
   * variant of the Market, whatever the type filter, since a barcode names one item anywhere).
   */
  async #duplicateGtins(market: MarketContext): Promise<string[]> {
    const groups = await this.prisma.tx(market).catalogProductRevisionVariant.groupBy({
      by: ['gtin'],
      where: { marketId: market.marketId, AND: [liveOf(market), { gtin: { not: null } }] },
      having: { gtin: { _count: { gt: 1 } } },
      orderBy: { gtin: 'asc' },
      take: DUPLICATE_GTIN_SCAN,
    });
    if (groups.length >= DUPLICATE_GTIN_SCAN) {
      // The filter and its count stop here; the cap is logged so the data gets fixed.
      this.#logger.warn({
        msg: 'catalog.variant-admin.duplicate-gtin-cap',
        marketId: market.marketId,
        cap: DUPLICATE_GTIN_SCAN,
      });
    }
    return groups.flatMap((group) => (group.gtin === null ? [] : [group.gtin]));
  }
}

const TYPE_INCLUDE = {
  publishedRevision: {
    include: {
      options: { orderBy: [{ position: 'asc' as const }, { optionCode: 'asc' as const }] },
    },
  },
  variantTypeSetting: { include: { currentRevision: true } },
} satisfies Prisma.CatalogAttributeDefinitionInclude;

type TypeRow = Prisma.CatalogAttributeDefinitionGetPayload<{ include: typeof TYPE_INCLUDE }>;

function typeOf(row: TypeRow): VariantTypeRecord | null {
  const revision = row.publishedRevision;
  if (revision === null || (row.status !== 'draft' && row.status !== 'active')) return null;
  const root = row.variantTypeSetting[0];
  const stored = root?.currentRevision ?? null;
  const settings: VariantTypeSettingsContent =
    stored === null
      ? DEFAULT_VARIANT_TYPE_SETTINGS
      : {
          displayStyle: stored.displayStyle as VariantDisplayStyle,
          optionOrder: stored.optionOrder as VariantOptionOrder,
          swatches: stringMap(stored.swatches),
          sellerHelp: stringMap(stored.sellerHelp),
        };
  return {
    id: row.id as Id<'AttributeDefinition'>,
    code: row.code,
    status: row.status,
    names: stringMap(revision.names),
    options: revision.options.map((option) => ({
      code: option.optionCode,
      labels: stringMap(option.labels),
      active: option.active,
      position: option.position,
    })),
    settings,
    settingsVersion: stored === null ? 0 : (root?.version ?? 0),
  };
}

/** The codes a family revision's groups offer as variant options. */
function variantCodesOf(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  return groups.flatMap((group: unknown) => {
    const list = (group as { attributes?: unknown } | null)?.attributes;
    if (!Array.isArray(list)) return [];
    return list.flatMap((entry: unknown) => {
      const attribute = entry as { code?: unknown; isVariantOption?: unknown } | null;
      return attribute !== null &&
        typeof attribute.code === 'string' &&
        attribute.isVariantOption === true
        ? [attribute.code]
        : [];
    });
  });
}
