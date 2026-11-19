import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SellerGroupPlan } from '../../domain/seller-import/row-check';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type { SaveDraft } from '../working-copy/save-draft.service';
import {
  OwnImportRowSave,
  type OwnImportRowSaveDependencies,
} from './own-import-row-save.use-case';

// `own-import.row-save` in memory, on both Market fixtures (catalog design 14c): a group that fails
// writes nothing (one all-or-nothing save, never a first save followed by a refusal), the ids a new
// variant gets are mapped inside that one save (never a second save a retry could repeat), and a
// plan that changes nothing makes no save.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const admitAll: AuthorisationCheck = { check: () => Promise.resolve({ allowed: true }) };

describe.each(['AU', 'ZZ'] as const)('own-import.row-save in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(Temporal.Instant.from('2026-11-07T00:00:00Z'));
  const ids = new SequenceIdGenerator(clock);
  const seller = ids.next<'Seller'>();
  const productId = ids.next<'Product'>();
  const liveVariant = ids.next<'Variant'>();
  const context: CallContext = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'seller',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: seller,
    }),
  );
  const locale = policy.locales(market).default;

  const planOf = (over: Partial<SellerGroupPlan> = {}): SellerGroupPlan => ({
    mode: 'my-products',
    kind: 'update',
    groupRow: 2,
    sellerSku: 'SKU-1',
    conditionCode: null,
    offerDescription: null,
    existing: null,
    catalogueProduct: null,
    product: {
      typeCode: 'simple',
      title: 'New title',
      shortDescription: null,
      description: null,
      categoryId: null,
      taxCategoryCode: null,
      attributeValues: {},
      imageNames: [],
      axes: [],
    },
    variants: [],
    ...over,
  });

  function rig(
    refuse = false,
    stored: Record<string, unknown> = { texts: { [locale]: { name: 'Old title' } } },
  ) {
    const saves: Record<string, unknown>[] = [];
    const written: unknown[] = [];
    const saveDraft = {
      execute: () => {
        throw new Error('the interactive save is not used by an import row');
      },
      executeAllOrNothing: (_c: CallContext, input: Record<string, unknown>) => {
        saves.push(input);
        if (refuse) {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: 'claim-text.refused' as const,
              fields: [{ field: 'name', ref: null, locale, code: 'claim-text.found', hits: [] }],
            },
          });
        }
        written.push(input['content']);
        const requested = input['variantIds'] as (string | null)[];
        return Promise.resolve({
          ok: true as const,
          value: {
            variantIds: requested.map((v) => v ?? 'minted-1'),
            refusedFields: [],
            variantNotices: [],
          },
        });
      },
    } as unknown as SaveDraft;
    const useCase = new OwnImportRowSave(createUseCaseGate(markets, admitAll), {
      unitOfWork: {
        run: async (_m: MarketContext, work: () => Promise<unknown>) => work(),
      } as unknown as UnitOfWork,
      products: {
        findById: () =>
          Promise.resolve({
            state: { ownerSellerId: seller, typeCode: 'simple', publishedRevisionId: null },
            liveVariants: [{ id: liveVariant }],
          }),
      } as unknown as ProductRepository,
      workingCopies: {
        find: () => Promise.resolve({ content: stored }),
      } as unknown as WorkingCopyRepository,
      revisions: { find: () => Promise.resolve(null) } as never,
      saveDraft,
      eligibility: { isEligible: () => Promise.resolve(true) },
      allowedTypes: { allowedFor: () => Promise.resolve('all') },
      policy,
    });
    return { useCase, saves, written };
  }

  it('makes one all-or-nothing save and, when a text is refused, writes nothing', async () => {
    const r = rig(true);
    const result = await r.useCase.execute(context, { productId, plan: planOf() });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'claim-text.refused', fields: [{ field: 'name' }] },
    });
    // One call to the all-or-nothing save and nothing else: no first save that wrote the other
    // fields, no second save.
    expect(r.saves).toHaveLength(1);
    expect(r.written).toEqual([]);
  });

  it('maps the ids of new variants inside the one save, with no second save', async () => {
    const r = rig();
    const result = await r.useCase.execute(context, {
      productId,
      plan: planOf({
        variants: [
          {
            rowNumber: 3,
            optionValues: { size: 'L' },
            optionKey: 'size=L',
            existingVariantId: null,
            gtin: null,
            shippingWeightGrams: null,
            shippingLengthMm: null,
            shippingWidthMm: null,
            shippingHeightMm: null,
          },
        ],
      }),
    });
    expect(result).toEqual({
      ok: true,
      value: { variantIds: [liveVariant, 'minted-1'], unchanged: false },
    });
    expect(r.saves).toHaveLength(1);
    // The new variant is saved under its placeholder, which the save replaces by the minted id.
    expect(r.saves[0]!['placeholders']).toEqual(['new-3']);
    expect(r.saves[0]!['variantIds'] as (Id<'Variant'> | null)[]).toEqual([liveVariant, null]);
    expect(JSON.stringify(r.saves[0]!['content'])).toContain('new-3');
  });

  it('makes no save for a plan that changes nothing', async () => {
    const r = rig(false, {
      texts: { [locale]: { name: 'New title' } },
      imageIds: [],
      variants: [{ variantId: liveVariant }],
    });
    const result = await r.useCase.execute(context, { productId, plan: planOf() });
    expect(result).toEqual({ ok: true, value: { variantIds: [liveVariant], unchanged: true } });
    expect(r.saves).toHaveLength(0);
  });

  it('refuses a seller who may not sell and an acting-as session, saving nothing', async () => {
    const r = rig();
    const deniedUseCase = new OwnImportRowSave(createUseCaseGate(markets, admitAll), {
      ...(r.useCase as unknown as { deps: Record<string, unknown> }).deps,
      eligibility: { isEligible: () => Promise.resolve(false) },
    } as unknown as OwnImportRowSaveDependencies);
    expect(await deniedUseCase.execute(context, { productId, plan: planOf() })).toEqual({
      ok: false,
      error: { code: 'seller.not-eligible' },
    });
    expect(r.saves).toHaveLength(0);
  });
});
