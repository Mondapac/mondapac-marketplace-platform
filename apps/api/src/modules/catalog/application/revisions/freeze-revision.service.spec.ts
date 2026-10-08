import { Temporal } from '@mondapac/shared-kernel';
import type { AttributeSchema, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import type { WorkingCopy } from '../../domain/working-copy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import { FreezeRevision } from './freeze-revision.service';

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const v = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;

// Two fixture Markets with a different default locale, tax list and variant limit.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', locales: ['en-AU'], tax: ['GST', 'GST_FREE'], max: 100 },
  { code: 'ZZ', locale: 'zz-ZZ', locales: ['yy-ZZ', 'zz-ZZ'], tax: ['STD', 'ZERO'], max: 3 },
] as const;

const schemaOf = (): AttributeSchema => ({
  schemaRef: {
    familyCode: 'default',
    familyRevisionId: 'fam-rev-1' as Id,
    definitionRevisionIds: ['def-rev-1' as Id, 'def-rev-2' as Id],
  },
  fields: [
    {
      code: 'origin',
      dataType: 'text',
      localizable: false,
      required: true,
      isVariantOption: false,
      material: false,
      claimChecked: true,
      bounds: { maxLength: 20 },
    },
    {
      code: 'tagline',
      dataType: 'text',
      localizable: true,
      required: true,
      isVariantOption: false,
      material: false,
      claimChecked: true,
      bounds: { maxLength: 40 },
    },
    {
      code: 'size',
      dataType: 'select',
      localizable: false,
      required: false,
      isVariantOption: true,
      material: false,
      claimChecked: true,
      bounds: { options: [{ code: 'l' }, { code: 's' }] },
    },
  ],
});

describe.each(MARKETS)('FreezeRevision in market $code', ({ code, locale, locales, tax, max }) => {
  const market = { marketId: code as MarketId, tenantId: 'default' } as unknown as MarketContext;
  let schema: AttributeSchema | null;
  let service: FreezeRevision;

  beforeEach(() => {
    schema = schemaOf();
    const attributes = {
      loadSchema: () => Promise.resolve(schema),
    } as unknown as AttributeRepository;
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => tax,
      locales: () => ({ default: locale, supported: locales }),
      sensitiveChanges: () => {
        throw new Error('not used');
      },
      maxVariantsPerProduct: () => max,
      approvalRequired: () => Promise.resolve(true),
    };
    service = new FreezeRevision({
      attributes,
      policy,
      handlerFor: (type) =>
        type === 'simple'
          ? simpleProductType
          : type === 'configurable'
            ? configurableProductType
            : undefined,
    });
  });

  function product(kind: 'simple' | 'configurable', variants = 2): Product {
    const created = Product.create({
      id: 'p1' as Id<'Product'>,
      marketId: code as MarketId,
      scope: 'SELLER',
      sellerId: 's1' as Id<'Seller'>,
      handler: kind === 'simple' ? simpleProductType : configurableProductType,
      familyCode: 'default',
      productCode: 'P00000001',
      variantId: kind === 'simple' ? v(1) : null,
      now: T0,
    });
    if (!created.ok) throw new Error(created.error.code);
    for (let n = 1; kind === 'configurable' && n <= variants; n += 1) {
      created.value.addVariant(v(n), 100, T0, 'seller');
    }
    return created.value;
  }

  const copyOf = (content: Record<string, unknown>): WorkingCopy => ({
    productId: 'p1' as Id<'Product'>,
    content,
    contentSchemaVersion: 1,
    baseRevisionId: null,
    lastSavedAt: T0,
    lastSavedByAccountId: 'a1' as Id<'Account'>,
  });

  const ready = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    texts: { [locale]: { name: 'Dates' } },
    categoryIds: ['c1'],
    taxCategoryCode: tax[0],
    attributeValues: { origin: 'AU', tagline: { [locale]: 'Sweet' } },
    imageIds: [],
    ...extra,
  });

  it('freezes a ready Simple draft with the server schema ref and a content hash', async () => {
    const result = await service.freeze(market, product('simple'), copyOf(ready()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content.schemaRef).toEqual({
      familyRevisionId: 'fam-rev-1',
      definitionRevisionIds: ['def-rev-1', 'def-rev-2'],
    });
    expect(result.value.contentHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ignores a schema ref the draft claims', async () => {
    const result = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ schemaRef: { familyRevisionId: 'forged', definitionRevisionIds: [] } })),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content.schemaRef.familyRevisionId).toBe('fam-rev-1');
  });

  it('gives the same hash for the same content and another for a changed one', async () => {
    const a = await service.freeze(market, product('simple'), copyOf(ready()));
    const b = await service.freeze(market, product('simple'), copyOf(ready()));
    const c = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ taxCategoryCode: tax[1] })),
    );
    expect(a.ok && b.ok && c.ok).toBe(true);
    if (!(a.ok && b.ok && c.ok)) return;
    expect(a.value.contentHash).toBe(b.value.contentHash);
    expect(a.value.contentHash).not.toBe(c.value.contentHash);
  });

  it('returns the issues of every check together', async () => {
    const result = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ attributeValues: {}, categoryIds: [], taxCategoryCode: 'NOPE' })),
    );
    expect(result.ok).toBe(false);
    if (result.ok || result.error.code !== 'revision.not-ready') return;
    const found = result.error.issues.map((issue) => `${issue.path}:${issue.code}`);
    expect(found).toEqual(
      expect.arrayContaining([
        'categoryIds:required',
        'taxCategoryCode:unknown',
        'origin:attribute.required',
      ]),
    );
  });

  it('refuses a text in a locale the Market does not list', async () => {
    const result = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ texts: { [locale]: { name: 'Dates' }, xx: { name: 'x' } } })),
    );
    if (result.ok || result.error.code !== 'revision.not-ready') throw new Error('expected issues');
    expect(result.error.issues).toContainEqual({ path: 'texts', code: 'unknown' });
  });

  it('requires a localizable attribute in the Market default locale, whatever its list position', async () => {
    const onlyOther = locales.find((l) => l !== locale) ?? 'xx';
    const result = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ attributeValues: { origin: 'AU', tagline: { [onlyOther]: 'Sweet' } } })),
    );
    if (locales.length > 1) {
      // A non-default locale alone is not enough: the default is required.
      if (result.ok || result.error.code !== 'revision.not-ready')
        throw new Error('expected issues');
      expect(result.error.issues.map((i) => i.code)).toContain('attribute.required');
    }
    const filled = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ attributeValues: { origin: 'AU', tagline: { [locale]: 'Sweet' } } })),
    );
    expect(filled.ok).toBe(true);
  });

  it('checks the option combinations of a Configurable draft', async () => {
    const good = await service.freeze(
      market,
      product('configurable'),
      copyOf(
        ready({
          variants: [
            { variantId: v(1), optionValues: { size: 'l' } },
            { variantId: v(2), optionValues: { size: 's' } },
          ],
        }),
      ),
    );
    expect(good.ok).toBe(true);

    const bad = await service.freeze(
      market,
      product('configurable'),
      copyOf(
        ready({
          variants: [
            { variantId: v(1), optionValues: { size: 'xl' } },
            { variantId: v(2), optionValues: { size: 's' } },
          ],
        }),
      ),
    );
    expect(bad).toMatchObject({ ok: false, error: { code: 'revision.not-ready' } });
    if (bad.ok || bad.error.code !== 'revision.not-ready') return;
    expect(bad.error.issues.map((issue) => issue.code)).toContain('variants.option-unknown');
  });

  it('applies the Market variant limit', async () => {
    const entries = [1, 2, 3, 4].map((n) => ({
      variantId: v(n),
      optionValues: { size: n % 2 ? 'l' : 's' },
    }));
    const result = await service.freeze(
      market,
      product('configurable', 4),
      copyOf(ready({ variants: entries })),
    );
    if (result.ok || result.error.code !== 'revision.not-ready') throw new Error('expected issues');
    const found = result.error.issues.map((issue) => issue.code);
    // ZZ allows 3 variants: four is too many. AU allows 100: only the repeated option sets fail.
    expect(found.includes('too-many')).toBe(max === 3);
    expect(found.includes('duplicate')).toBe(max !== 3);
  });

  it('refuses a working copy of another product and a handler of another variant model (L3, L4)', async () => {
    await expect(
      service.freeze(market, product('simple'), {
        ...copyOf(ready()),
        productId: 'other' as Id<'Product'>,
      }),
    ).rejects.toThrow(/do not belong together/);
    const mismatched = new FreezeRevision({
      attributes: {
        loadSchema: () => Promise.resolve(schemaOf()),
      } as unknown as AttributeRepository,
      policy: {} as CatalogMarketPolicy,
      handlerFor: () => configurableProductType,
    });
    expect(await mismatched.freeze(market, product('simple'), copyOf(ready()))).toEqual({
      ok: false,
      error: { code: 'revision.type-unknown' },
    });
  });

  it('does not echo a key the seller typed (L-1)', async () => {
    const result = await service.freeze(
      market,
      product('simple'),
      copyOf(ready({ texts: { [locale]: { name: 'Dates' }, ['x'.repeat(300)]: { name: 'x' } } })),
    );
    if (result.ok || result.error.code !== 'revision.not-ready') throw new Error('expected issues');
    expect(JSON.stringify(result.error.issues)).not.toContain('xxxx');
  });

  it('fails closed when the schema or the type handler is missing', async () => {
    schema = null;
    expect(await service.freeze(market, product('simple'), copyOf(ready()))).toEqual({
      ok: false,
      error: { code: 'revision.schema-unavailable' },
    });
    const unknown = new FreezeRevision({
      attributes: {
        loadSchema: () => Promise.resolve(schemaOf()),
      } as unknown as AttributeRepository,
      policy: {} as CatalogMarketPolicy,
      handlerFor: () => undefined,
    });
    expect(await unknown.freeze(market, product('simple'), copyOf(ready()))).toEqual({
      ok: false,
      error: { code: 'revision.type-unknown' },
    });
  });
});
