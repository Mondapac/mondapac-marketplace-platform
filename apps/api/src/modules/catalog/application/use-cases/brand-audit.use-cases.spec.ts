import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import type { Id } from '@mondapac/shared-kernel';
import { brandState, MemoryBrands } from '../../../../../test/support/catalog-brand-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_BRAND_EDIT, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import { BrandApprove } from './brand-approve.use-case';
import { BrandArchive } from './brand-archive.use-case';
import { BrandCreate } from './brand-create.use-case';
import { BrandEdit } from './brand-edit.use-case';
import { BrandMerge } from './brand-merge.use-case';
import { BrandMergeQueueDismiss } from './brand-merge-queue-dismiss.use-case';
import { OwnBrandPropose } from './own-brand-propose.use-case';

// One audit row per brand write (attributes A5, closing #552's open point): created, proposed,
// edited, approved, archived, merged and a merge-queue group kept apart. A refused write leaves no
// row, and no row carries a name, a summary or any other text of the brand. The routes are in
// test/catalog-brand.e2e.spec.ts; the key gate and the closed bodies are proved there.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-03T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';
const SELLER = '01990000-0000-7000-8000-0000000000a3' as Id<'Seller'>;
const id = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Brand'>;

describe.each(['AU', 'ZZ'] as const)('brand audit in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId: population === 'seller' ? (SELLER) : null,
      }),
    );

  let brands: MemoryBrands;
  let audits: AuditEntry[];
  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          (declaration.rule.allOf.includes(CATALOG_BRAND_EDIT.key) ||
            declaration.rule.allOf.includes(CATALOG_OWN_PRODUCT_EDIT.key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const base = { unitOfWork, brands, clock, audit };
    return {
      create: new BrandCreate(gate, { ...base, ids }),
      edit: new BrandEdit(gate, base),
      approve: new BrandApprove(gate, base),
      archive: new BrandArchive(gate, base),
      merge: new BrandMerge(gate, base),
      dismiss: new BrandMergeQueueDismiss(gate, base),
      propose: new OwnBrandPropose(gate, {
        ...base,
        ids,
        brandReader: brands,
        eligibility: { isEligible: () => Promise.resolve(true) },
      }),
    };
  };

  beforeEach(() => {
    brands = new MemoryBrands();
    audits = [];
  });

  const actions = () => audits.map((entry) => entry.action);

  it('records an admin-created brand as active, with its origin and no name', async () => {
    const answer = await build().create.execute(context(), { name: 'Fuji Foods' });
    if (!answer.ok) throw new Error(answer.error.code);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'catalog.brand.created',
      targetType: 'catalog.brand',
      targetId: answer.value.brand.id,
      after: { status: 'active', origin: 'admin' },
    });
    expect(JSON.stringify(audits)).not.toContain('Fuji');
  });

  it('records a seller proposal as a draft with the seller origin', async () => {
    brands.ownBrandSellers.add(`${code}:${SELLER}`);

    const answer = await build().propose.execute(context('seller'), { name: 'Kiri Tea' });
    if (!answer.ok) throw new Error(answer.error.code);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'catalog.brand.proposed',
      targetId: answer.value.brandId,
      after: { status: 'draft', origin: 'seller' },
    });
  });

  it('records which parts of the content an edit changed, never the text', async () => {
    brands.seed(brandState(id(1), 'Fuji Foods'));

    const answer = await build().edit.execute(context(), {
      brandId: id(1),
      version: 1,
      name: 'Fuji Foods',
      summary: 'Noodles',
    });
    if (!answer.ok) throw new Error(answer.error.code);

    expect(audits[0]).toMatchObject({
      action: 'catalog.brand.edited',
      before: { status: 'active' },
      after: {
        status: 'active',
        nameChanged: false,
        slugChanged: false,
        summaryChanged: true,
        originCountryChanged: false,
        imagesChanged: false,
      },
    });
    expect(JSON.stringify(audits)).not.toContain('Noodles');
  });

  it('records the approval of a seller draft and the archive of a brand', async () => {
    brands.seed(brandState(id(2), 'Kiri Tea', { status: 'draft', proposedBySellerId: SELLER }));
    brands.seed(brandState(id(3), 'Old Co'));

    const approved = await build().approve.execute(context(), { brandId: id(2), version: 1 });
    const archived = await build().archive.execute(context(), { brandId: id(3), version: 1 });
    expect(approved.ok && archived.ok).toBe(true);

    expect(audits).toHaveLength(2);
    expect(audits[0]).toMatchObject({
      action: 'catalog.brand.approved',
      targetId: id(2),
      before: { status: 'draft' },
      after: { status: 'active', proposedBySeller: true },
    });
    expect(audits[1]).toMatchObject({
      action: 'catalog.brand.archived',
      targetId: id(3),
      before: { status: 'active' },
      after: { status: 'archived' },
    });
  });

  it('records a merge on the target with counts only', async () => {
    brands.seed(brandState(id(4), 'Fuji Foods'));
    brands.seed(brandState(id(5), 'Fuji Food Co'));
    brands.productCounts.set(`${code}:${id(5)}`, 3);

    const answer = await build().merge.execute(context(), {
      brandId: id(4),
      sourceBrandIds: [id(5)],
    });
    if (!answer.ok) throw new Error(answer.error.code);

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'catalog.brand.merged',
      targetId: id(4),
      after: { sourceCount: 1, aliasesAdded: answer.value.aliasesAdded.length },
    });
  });

  it('records one row per brand of a group kept apart', async () => {
    brands.seed(brandState(id(6), 'Fuji Foods'));
    brands.seed(brandState(id(7), 'Fuji-Foods'));
    brands.candidates.push(
      { groupKey: 'fujifoods', brandId: id(6), status: 'open' },
      { groupKey: 'fujifoods', brandId: id(7), status: 'open' },
    );

    const answer = await build().dismiss.execute(context(), { groupKey: 'fujifoods' });

    expect(answer).toEqual({ ok: true, value: { resolved: 2 } });
    expect(actions()).toEqual(['catalog.brand.merge-dismissed', 'catalog.brand.merge-dismissed']);
    expect(audits.map((entry) => entry.targetId)).toEqual([id(6), id(7)]);
    expect(audits[0]).toMatchObject({ after: { groupSize: 2 } });
  });

  it('writes no row for a refused write', async () => {
    brands.seed(brandState(id(8), 'Fuji Foods'));

    const stale = await build().edit.execute(context(), {
      brandId: id(8),
      version: 9,
      name: 'Fuji Foods',
    });
    const unknown = await build().approve.execute(context(), { brandId: id(9), version: 1 });
    const none = await build().dismiss.execute(context(), { groupKey: 'nothing' });

    expect(stale).toMatchObject({ ok: false, error: { code: 'conflict.stale' } });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'brand.not-found' } });
    expect(none).toMatchObject({
      ok: false,
      error: { code: 'brand-merge-queue.group-not-found' },
    });
    expect(audits).toEqual([]);
  });
});
