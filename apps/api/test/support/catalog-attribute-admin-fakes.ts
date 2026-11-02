import { Temporal } from '@mondapac/shared-kernel';
import type { AttributeDataType, Id, MarketContext } from '@mondapac/shared-kernel';
import type {
  AttributeAdminReader,
  AttributeDefinitionRecord,
  AttributeRevisionRecord,
  CountedField,
  FeatureSetRecord,
} from '../../src/modules/catalog/application/ports/attribute-admin.reader';
import {
  DEFAULT_DISPLAY_SETTINGS,
  type AttributeOption,
  type LocalizedText,
} from '../../src/modules/catalog/domain/attribute-definition';
import type { FamilyGroup } from '../../src/modules/catalog/domain/attribute-family';

// An in-memory AttributeAdminReader for the use-case specs and the HTTP tests (attributes package
// A1). Records are kept per Market, so a read of one Market never sees another's; counts are set
// by hand per Market and code. The SQL is tested in test/db/catalog-attribute-admin.db-spec.ts.

const T0 = Temporal.Instant.from('2026-10-01T00:00:00Z');

export function revisionRecord(
  id: string,
  revisionNo: number,
  overrides: Partial<AttributeRevisionRecord> = {},
): AttributeRevisionRecord {
  return {
    id: id as Id<'AttributeDefinitionRevision'>,
    revisionNo,
    material: false,
    isVariantOption: false,
    bounds: {},
    names: { 'en-AU': 'Name' },
    options: [],
    display: DEFAULT_DISPLAY_SETTINGS,
    authorKind: 'seed',
    authorAccountId: null,
    createdAt: T0,
    ...overrides,
  };
}

export function definitionRecord(
  id: string,
  code: string,
  options: {
    readonly dataType?: AttributeDataType;
    readonly status?: string;
    readonly names?: LocalizedText;
    readonly material?: boolean;
    readonly isVariantOption?: boolean;
    readonly values?: readonly AttributeOption[];
    readonly revisionNo?: number;
  } = {},
): AttributeDefinitionRecord {
  return {
    id: id as Id<'AttributeDefinition'>,
    code,
    dataType: options.dataType ?? 'text',
    localizable: false,
    status: options.status ?? 'active',
    createdByKind: 'seed',
    createdAt: T0,
    version: 1,
    revision: revisionRecord(`${id.slice(0, -4)}ffff`, options.revisionNo ?? 1, {
      names: options.names ?? { 'en-AU': code },
      material: options.material ?? false,
      isVariantOption: options.isVariantOption ?? false,
      options: options.values ?? [],
    }),
  };
}

export function featureSetRecord(
  id: string,
  code: string,
  groups: readonly FamilyGroup[],
  status = 'active',
): FeatureSetRecord {
  return {
    id: id as Id<'AttributeFamily'>,
    code,
    status,
    createdByKind: 'seed',
    createdAt: T0,
    revisionNo: 1,
    groups,
  };
}

export class MemoryAttributeAdminReader implements AttributeAdminReader {
  readonly definitionsOf = new Map<string, AttributeDefinitionRecord[]>();
  readonly revisionsOf = new Map<string, AttributeRevisionRecord[]>();
  readonly featureSetsOf = new Map<string, FeatureSetRecord[]>();
  /** `${marketId}:${code}` to the products holding a value. */
  readonly counts = new Map<string, number>();
  /** `${marketId}:${code}:${option}`. */
  readonly optionCounts = new Map<string, number>();
  /** `${marketId}:${featureSetId}`. */
  readonly featureSetCounts = new Map<string, number>();

  reset(): void {
    this.definitionsOf.clear();
    this.revisionsOf.clear();
    this.featureSetsOf.clear();
    this.counts.clear();
    this.optionCounts.clear();
    this.featureSetCounts.clear();
  }

  seedDefinition(
    marketId: string,
    record: AttributeDefinitionRecord,
    history?: readonly AttributeRevisionRecord[],
  ): void {
    const list = this.definitionsOf.get(marketId) ?? [];
    list.push(record);
    list.sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
    this.definitionsOf.set(marketId, list);
    this.revisionsOf.set(`${marketId}:${record.id}`, [...(history ?? [record.revision])]);
  }

  seedFeatureSet(marketId: string, record: FeatureSetRecord): void {
    const list = this.featureSetsOf.get(marketId) ?? [];
    list.push(record);
    list.sort((a, b) => (a.code < b.code ? -1 : 1));
    this.featureSetsOf.set(marketId, list);
  }

  definitions(market: MarketContext, limit: number) {
    return Promise.resolve((this.definitionsOf.get(market.marketId) ?? []).slice(0, limit));
  }

  definition(market: MarketContext, id: Id<'AttributeDefinition'>) {
    return Promise.resolve(
      (this.definitionsOf.get(market.marketId) ?? []).find((record) => record.id === id) ?? null,
    );
  }

  revisions(market: MarketContext, id: Id<'AttributeDefinition'>, limit: number) {
    const all = this.revisionsOf.get(`${market.marketId}:${id}`) ?? [];
    return Promise.resolve([...all].sort((a, b) => b.revisionNo - a.revisionNo).slice(0, limit));
  }

  featureSets(market: MarketContext, limit: number) {
    return Promise.resolve((this.featureSetsOf.get(market.marketId) ?? []).slice(0, limit));
  }

  featureSet(market: MarketContext, id: Id<'AttributeFamily'>) {
    return Promise.resolve(
      (this.featureSetsOf.get(market.marketId) ?? []).find((record) => record.id === id) ?? null,
    );
  }

  productCounts(market: MarketContext, fields: readonly CountedField[]) {
    return Promise.resolve(
      new Map(
        fields.map((field) => [
          field.code,
          this.counts.get(`${market.marketId}:${field.code}`) ?? 0,
        ]),
      ),
    );
  }

  optionProductCounts(
    market: MarketContext,
    field: CountedField & { readonly dataType: AttributeDataType },
    optionCodes: readonly string[],
  ) {
    return Promise.resolve(
      new Map(
        optionCodes.map((code) => [
          code,
          this.optionCounts.get(`${market.marketId}:${field.code}:${code}`) ?? 0,
        ]),
      ),
    );
  }

  featureSetProductCounts(market: MarketContext, ids: readonly Id<'AttributeFamily'>[]) {
    return Promise.resolve(
      new Map(ids.map((id) => [id, this.featureSetCounts.get(`${market.marketId}:${id}`) ?? 0])),
    );
  }
}
