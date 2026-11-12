import { Temporal } from '@mondapac/shared-kernel';
import type { MarketContext } from '@mondapac/shared-kernel';
import type { Prisma } from '../../../generated/prisma/client';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type {
  SeoSettingsRecord,
  SeoSettingsRepository,
} from '../application/ports/seo-settings.repository';
import {
  INDEXING_VALUES,
  SELLER_PAGES_VALUES,
  TEMPLATE_PAGE_TYPES,
  type PageTemplates,
  type PostalAddress,
  type SeoSettings,
  type ShareImage,
} from '../domain/seo-settings';

/** A stored enum value; the table's CHECKs make anything else unreachable. */
function stored<T extends string>(options: readonly T[], value: string): T {
  if (!(options as readonly string[]).includes(value)) {
    throw new Error(`storefront.seo_settings holds an unknown value "${value}"`);
  }
  return value as T;
}

const imageOf = (ref: string | null, alt: string | null): ShareImage | null =>
  ref === null || alt === null ? null : { ref, alt };

function templatesOf(json: Prisma.JsonValue): PageTemplates {
  const raw = json as Record<string, { title: string | null; description: string | null }>;
  return Object.fromEntries(
    TEMPLATE_PAGE_TYPES.map((type) => [
      type,
      { title: raw[type]?.title ?? null, description: raw[type]?.description ?? null },
    ]),
  ) as unknown as PageTemplates;
}

type Row = Prisma.StorefrontSeoSettingsGetPayload<object>;

function recordOf(row: Row): SeoSettingsRecord {
  const address: PostalAddress | null =
    row.addressStreet === null ||
    row.addressCity === null ||
    row.addressState === null ||
    row.addressPostcode === null ||
    row.addressCountry === null
      ? null
      : {
          street: row.addressStreet,
          city: row.addressCity,
          state: row.addressState,
          postcode: row.addressPostcode,
          country: row.addressCountry,
        };
  const settings: SeoSettings = {
    indexing: stored(INDEXING_VALUES, row.indexing),
    siteName: row.siteName,
    titleTemplate: row.titleTemplate,
    defaultDescription: row.defaultDescription,
    defaultShareImage: imageOf(row.shareImageRef, row.shareImageAlt),
    logo: imageOf(row.logoRef, row.logoAlt),
    sellerPages: stored(SELLER_PAGES_VALUES, row.sellerPages),
    tradingName: row.tradingName,
    legalName: row.legalName,
    abn: row.abn,
    postalAddress: address,
    contactEmail: row.contactEmail,
    contactPhone: row.contactPhone,
    sameAs: row.sameAs,
    googleVerification: row.googleVerification,
    bingVerification: row.bingVerification,
    analyticsId: row.analyticsId,
    pageTemplates: templatesOf(row.pageTemplates),
  };
  return {
    version: row.version,
    settings,
    changedAt: Temporal.Instant.fromEpochMilliseconds(row.changedAt.getTime()),
  };
}

/** {@link SeoSettingsRepository} on `storefront.seo_settings`, scoped by `marketId`. */
export class PrismaSeoSettingsRepository implements SeoSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async latest(market: MarketContext): Promise<SeoSettingsRecord | null> {
    const row = await this.prisma.tx(market).storefrontSeoSettings.findFirst({
      where: { marketId: market.marketId },
      orderBy: { version: 'desc' },
    });
    return row === null ? null : recordOf(row);
  }

  async find(market: MarketContext, version: number): Promise<SeoSettingsRecord | null> {
    const row = await this.prisma.tx(market).storefrontSeoSettings.findFirst({
      where: { marketId: market.marketId, version },
    });
    return row === null ? null : recordOf(row);
  }

  async append(
    market: MarketContext,
    record: Parameters<SeoSettingsRepository['append']>[1],
  ): Promise<boolean> {
    const s = record.settings;
    const created = await this.prisma.tx(market).storefrontSeoSettings.createMany({
      data: [
        {
          marketId: market.marketId,
          tenantId: market.tenantId,
          version: record.version,
          indexing: s.indexing,
          siteName: s.siteName,
          titleTemplate: s.titleTemplate,
          defaultDescription: s.defaultDescription,
          shareImageRef: s.defaultShareImage?.ref ?? null,
          shareImageAlt: s.defaultShareImage?.alt ?? null,
          logoRef: s.logo?.ref ?? null,
          logoAlt: s.logo?.alt ?? null,
          sellerPages: s.sellerPages,
          tradingName: s.tradingName,
          legalName: s.legalName,
          abn: s.abn,
          addressStreet: s.postalAddress?.street ?? null,
          addressCity: s.postalAddress?.city ?? null,
          addressState: s.postalAddress?.state ?? null,
          addressPostcode: s.postalAddress?.postcode ?? null,
          addressCountry: s.postalAddress?.country ?? null,
          contactEmail: s.contactEmail,
          contactPhone: s.contactPhone,
          sameAs: [...s.sameAs],
          googleVerification: s.googleVerification,
          bingVerification: s.bingVerification,
          analyticsId: s.analyticsId,
          pageTemplates: s.pageTemplates as unknown as Prisma.InputJsonValue,
          changedAt: new Date(record.changedAt.epochMilliseconds),
          changedBy: record.changedBy,
        },
      ],
      skipDuplicates: true,
    });
    return created.count === 1;
  }
}
