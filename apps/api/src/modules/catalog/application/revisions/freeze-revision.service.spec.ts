import { Temporal } from '@mondapac/shared-kernel';
import type { AttributeSchema, Id, MarketContext, MarketId } from '@mondapac/shared-kernel';
import { Product } from '../../domain/product';
import { configurableProductType } from '../../domain/product-types/configurable';
import { simpleProductType } from '../../domain/product-types/simple';
import type { WorkingCopy } from '../../domain/working-copy';
import type { AttributeRepository } from '../ports/attribute.repository';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import { FreezeRevision } from './freeze-revision.service';
import { fixedFamilyResolver } from '../../../../../test/support/family-resolver';

const T0 = Temporal.Instant.from('2026-10-08T00:00:00Z');
const v = (n: number): Id<'Variant'> => `v${n}` as Id<'Variant'>;

// Two fixture Markets with a different default locale, tax list and variant limit.
const MARKETS = [
  { code: 'AU', locale: 'en-AU', locales: ['en-AU'], tax: ['GST', 'GST_FREE'], max: 100 },
  { code: 'ZZ', locale: 'zz-ZZ', locales: ['yy-ZZ', 'zz-ZZ'], tax: ['STD', 'ZERO'], max: 3 },
] as const;

const ALL_LOCALES = ['en-AU', 'yy-ZZ', 'zz-ZZ'] as const;

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
      bounds: {
        options: [
          { code: 'l', labels: Object.fromEntries(ALL_LOCALES.map((l) => [l, `Large ${l}`])) },
          // Small has a label in the first locale only (V2: that locale alone gets a label).
          { code: 's', labels: { [ALL_LOCALES[0]]: `Small ${ALL_LOCALES[0]}` } },
        ],
      },
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
      activeDefinitionCodes: (_m: MarketContext, codes: readonly string[]) =>
        Promise.resolve(new Set(codes.filter((c) => c !== 'stray'))),
    } as unknown as AttributeRepository;
    const policy: CatalogMarketPolicy = {
      taxCategoryCodes: () => tax,
      locales: () => ({ default: locale, supported: locales }),
      sensitiveChanges: () => {
        throw new Error('not used');
      },
      maxVariantsPerProduct: () => max,
      maxVariantAttributes: () => 2,
      maxCategoryDepth: () => 4,
      maxCategoryChangeTags: () => 50_000,
      productTypes: () => ['simple', 'configurable'],
      defaultFamily: () => 'default',
      conditions: () => ['new'],
      sellFromCatalogue: () => Promise.resolve(true),
      sellerCanCreateProduct: () => Promise.resolve(true),
      approvalRequired: () => Promise.resolve(true),
    };
    service = new FreezeRevision({
      familyResolver: fixedFamilyResolver(),
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

  describe('the feature set follows the primary category (CAT-10, decision ت۱۰)', () => {
    const codesOf = (result: Awaited<ReturnType<FreezeRevision['freeze']>>): string[] =>
      !result.ok && result.error.code === 'revision.not-ready'
        ? result.error.issues.map((issue) => issue.code)
        : [];
    const only = (...fields: string[]): AttributeSchema => {
      const base = schemaOf();
      return { ...base, fields: base.fields.filter((field) => fields.includes(field.code)) };
    };

    function following(
      resolve: () => Promise<{ ok: true; familyCode: string } | { ok: false; code: string }>,
      loaded: string[] = [],
    ): FreezeRevision {
      const deps = (service as unknown as { deps: Record<string, unknown> }).deps;
      return new FreezeRevision({
        ...deps,
        familyResolver: { resolve } as never,
        attributes: {
          activeDefinitionCodes: (_m: MarketContext, codes: readonly string[]) =>
            Promise.resolve(new Set(codes.filter((c) => c !== 'stray'))),
          loadSchema: (_m: MarketContext, familyCode: string) => {
            loaded.push(familyCode);
            return Promise.resolve(familyCode === 'frozen' ? only('origin') : schemaOf());
          },
        } as unknown as AttributeRepository,
      } as never);
    }

    it('freezes under the resolved family, resolved from the first category listed', async () => {
      const asked: unknown[] = [];
      const loaded: string[] = [];
      const follow = following(() => Promise.resolve({ ok: true, familyCode: 'frozen' }), loaded);
      (
        follow as unknown as { deps: { familyResolver: { resolve: unknown } } }
      ).deps.familyResolver = {
        resolve: (_m: unknown, categoryId: unknown) => {
          asked.push(categoryId);
          return Promise.resolve({ ok: true, familyCode: 'frozen' });
        },
      };
      const result = await follow.freeze(
        market,
        product('simple'),
        copyOf(ready({ categoryIds: ['c9', 'c1'] })),
      );
      expect(asked).toEqual(['c9']);
      expect(loaded).toEqual(['frozen']);
      expect(result.ok && result.value.familyCode).toBe('frozen');
    });

    it('leaves out values the new feature set has no field for, and keeps the shared ones', async () => {
      const follow = following(() => Promise.resolve({ ok: true, familyCode: 'frozen' }));
      const result = await follow.freeze(market, product('simple'), copyOf(ready()));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.content.attributeValues).toEqual({ origin: 'AU' });
    });

    it('still refuses an unknown value when the family did not change', async () => {
      const result = await service.freeze(
        market,
        product('simple'),
        copyOf(
          ready({ attributeValues: { origin: 'AU', tagline: { [locale]: 'x' }, stray: 'y' } }),
        ),
      );
      expect(codesOf(result)).toContain('attribute.unknown');
    });

    it('asks for a required field the new family adds', async () => {
      const follow = following(() => Promise.resolve({ ok: true, familyCode: 'frozen' }));
      const result = await follow.freeze(
        market,
        product('simple'),
        copyOf(ready({ attributeValues: { tagline: { [locale]: 'Sweet' } } })),
      );
      expect(codesOf(result)).toContain('attribute.required');
    });

    it('names an option the new feature set does not hold, and leaves the working copy as it was', async () => {
      const follow = following(() => Promise.resolve({ ok: true, familyCode: 'frozen' }));
      const copy = copyOf(
        ready({
          variantAxes: ['size'],
          variants: [{ variantId: v(1), optionValues: { size: 'l' } }],
        }),
      );
      const before = JSON.stringify(copy.content);
      const result = await follow.freeze(market, product('configurable'), copy);
      expect(codesOf(result)).toContain('variants.option-not-in-family');
      expect(codesOf(result)).not.toContain('variants.axes-unknown');
      // A move back finds every value the seller had entered.
      expect(JSON.stringify(copy.content)).toBe(before);
    });

    it('does not refuse the values of another feature set when the product moves back to its own', async () => {
      // After a reject the column is back on the old set while the working copy still holds the
      // new set's values: they are left out, never met as unknown (CAT-10).
      const deps = (service as unknown as { deps: Record<string, unknown> }).deps;
      const back = new FreezeRevision({
        ...deps,
        familyResolver: { resolve: () => Promise.resolve({ ok: true, familyCode: 'default' }) },
        attributes: {
          activeDefinitionCodes: (_m: MarketContext, codes: readonly string[]) =>
            Promise.resolve(new Set(codes.filter((c) => c !== 'stray'))),
          loadSchema: () => Promise.resolve(only('origin')),
        } as unknown as AttributeRepository,
      } as never);
      const result = await back.freeze(market, product('simple'), copyOf(ready()));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.content.attributeValues).toEqual({ origin: 'AU' });
      const stray = await back.freeze(
        market,
        product('simple'),
        copyOf(ready({ attributeValues: { origin: 'AU', stray: 'y' } })),
      );
      expect(codesOf(stray)).toContain('attribute.unknown');
    });

    it('a dropped material attribute is no relaxation: the revision just does not carry it', async () => {
      const deps = (service as unknown as { deps: Record<string, unknown> }).deps;
      const moved = new FreezeRevision({
        ...deps,
        familyResolver: { resolve: () => Promise.resolve({ ok: true, familyCode: 'frozen' }) },
        attributes: {
          activeDefinitionCodes: (_m: MarketContext, codes: readonly string[]) =>
            Promise.resolve(new Set(codes)),
          loadSchema: () => Promise.resolve(only('origin')),
        } as unknown as AttributeRepository,
      } as never);
      const result = await moved.freeze(
        market,
        product('simple'),
        copyOf(ready({ attributeValues: { origin: 'AU', cert: 'x' } })),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.content.attributeValues).toEqual({ origin: 'AU' });
      expect(result.value.familyCode).toBe('frozen');
    });

    it('fails closed when the family cannot be resolved, and gives a product without a category the default', async () => {
      const failed = following(() => Promise.resolve({ ok: false, code: 'family.unavailable' }));
      expect(await failed.freeze(market, product('simple'), copyOf(ready()))).toEqual({
        ok: false,
        error: { code: 'revision.schema-unavailable' },
      });
      const asked: unknown[] = [];
      const none = following(() => Promise.resolve({ ok: true, familyCode: 'default' }));
      (none as unknown as { deps: { familyResolver: { resolve: unknown } } }).deps.familyResolver =
        {
          resolve: (_m: unknown, categoryId: unknown) => {
            asked.push(categoryId);
            return Promise.resolve({ ok: true, familyCode: 'default' });
          },
        };
      await none.freeze(market, product('simple'), copyOf(ready({ categoryIds: [] })));
      expect(asked).toEqual([null]);
    });
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

  describe('variant axes (V3)', () => {
    const variants = [
      { variantId: v(1), optionValues: { size: 'l' } },
      { variantId: v(2), optionValues: { size: 's' } },
    ];
    const codesOf = (result: Awaited<ReturnType<FreezeRevision['freeze']>>): string[] =>
      !result.ok && result.error.code === 'revision.not-ready'
        ? result.error.issues.map((issue) => issue.code)
        : [];

    it('freezes a draft that names the axis it varies on', async () => {
      const result = await service.freeze(
        market,
        product('configurable'),
        copyOf(ready({ variantAxes: ['size'], variants })),
      );
      expect(result.ok).toBe(true);
    });

    it.each([
      [[], 'variants.axes-none'],
      [['weight'], 'variants.axes-unknown'],
      [['size', 'size'], 'variants.axes-duplicate'],
    ])('refuses variantAxes %j with %s', async (variantAxes, issue) => {
      const result = await service.freeze(
        market,
        product('configurable'),
        copyOf(ready({ variantAxes, variants })),
      );
      expect(codesOf(result)).toContain(issue);
    });

    it('refuses axes that differ from the published revision', async () => {
      const draft = product('configurable');
      const published = new Proxy(draft, {
        get: (target, prop) =>
          prop === 'state'
            ? { ...target.state, publishedRevisionId: 'rev-1' as Id<'ProductRevision'> }
            : (Reflect.get(target, prop, target) as unknown),
      });
      const revisions = {
        find: () =>
          Promise.resolve({ content: { variants: [{ optionValues: { colour: 'red' } }] } }),
      } as unknown as ProductRevisionRepository;
      const locked = new FreezeRevision({
        familyResolver: fixedFamilyResolver(),
        attributes: { loadSchema: () => Promise.resolve(schema) } as unknown as AttributeRepository,
        policy: (service as unknown as { deps: { policy: CatalogMarketPolicy } }).deps.policy,
        handlerFor: () => configurableProductType,
        revisions,
      });
      const changed = await locked.freeze(
        market,
        published,
        copyOf(ready({ variantAxes: ['size'], variants })),
      );
      expect(codesOf(changed)).toContain('variants.axes-locked');
    });
  });

  it('builds the variant labels from the option labels and drops a locale with a missing one (V2)', async () => {
    const frozen = await service.freeze(
      market,
      product('configurable'),
      copyOf(
        ready({
          variants: [
            { variantId: v(1), optionValues: { size: 'l' }, labels: { [locale]: 'Seller typed' } },
            { variantId: v(2), optionValues: { size: 's' } },
          ],
        }),
      ),
    );
    expect(frozen.ok).toBe(true);
    if (!frozen.ok) return;
    const [large, small] = frozen.value.content.variants;
    expect(large?.labels).toEqual(Object.fromEntries(locales.map((l) => [l, `Large ${l}`])));
    // 'Small' exists in en-AU only: AU gets it, ZZ (yy-ZZ, zz-ZZ) has no label for that variant.
    expect(small?.labels).toEqual(
      locales.includes('en-AU' as never) ? { 'en-AU': 'Small en-AU' } : {},
    );
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
      familyResolver: fixedFamilyResolver(),
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
      familyResolver: fixedFamilyResolver(),
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
  it('reports a required field whose value suggestion is open as pending, not as missing', async () => {
    const withSuggestions = new FreezeRevision({
      familyResolver: fixedFamilyResolver(),
      attributes: { loadSchema: () => Promise.resolve(schema) } as unknown as AttributeRepository,
      policy: {
        taxCategoryCodes: () => tax,
        locales: () => ({ default: locale, supported: locales }),
        maxVariantsPerProduct: () => max,
        maxVariantAttributes: () => 2,
      } as unknown as CatalogMarketPolicy,
      handlerFor: (type) => (type === 'simple' ? simpleProductType : undefined),
      suggestions: {
        openAttributeCodesOfProduct: () => Promise.resolve(new Set(['origin'])),
      } as unknown as AttributeValueSuggestionStore,
    });
    const content = ready({ attributeValues: { tagline: { [locale]: 'Sweet' } } });
    const result = await withSuggestions.freeze(market, product('simple'), copyOf(content));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ code: 'revision.not-ready' });
    const issues = result.error.code === 'revision.not-ready' ? result.error.issues : [];
    expect(issues.map((i) => `${i.path}:${i.code}`)).toEqual([
      'origin:attribute.suggestion-pending',
    ]);
    // Without the suggestion the same draft says the field is missing.
    const plain = await service.freeze(market, product('simple'), copyOf(content));
    expect(
      plain.ok === false && plain.error.code === 'revision.not-ready' && plain.error.issues,
    ).toEqual([{ path: 'origin', code: 'attribute.required' }]);
  });
});
