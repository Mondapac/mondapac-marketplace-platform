import { Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { MemorySellerSavedFilters } from '../../../../../test/support/saved-filter-fakes';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { OwnSavedFilterCreate } from './own-saved-filter-create.use-case';
import { OwnSavedFilterDelete } from './own-saved-filter-delete.use-case';
import { OwnSavedFilterShareCheck } from './own-saved-filter-share-check.use-case';
import { OwnSavedFilterUpdate } from './own-saved-filter-update.use-case';
import { OwnSavedFiltersList } from './own-saved-filters-list.use-case';

// A Login-as-Seller session (SEL-08) writes none of the seller's saved filters. No minted actor can
// carry the reserved `actingAs` marker yet (the kernel copies only the declared fields), so the
// marker is simulated here through the one function every catalog use case reads it with.

const acting = { value: false };
jest.mock('../acting-as', () => ({ isActingAsSession: () => acting.value }));

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const gate = createUseCaseGate(markets, {
  check: () => Promise.resolve({ allowed: true }),
});

describe.each(['AU', 'ZZ'] as const)(
  'seller saved filters in a Login-as-Seller session, %s',
  (code) => {
    const market = testMarketContext(code, 'default');
    const clock = new FixedClock(Temporal.Instant.from('2026-11-07T00:00:00Z'));
    const ids = new SequenceIdGenerator(clock);
    const context = testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: ids.next<'Seller'>(),
      }),
    );
    const repo = new MemorySellerSavedFilters();
    const audits: unknown[] = [];
    const audit: AuditWriter = {
      record: (_c, entry) => {
        audits.push(entry);
        return Promise.resolve();
      },
    };
    const unitOfWork = {
      run: (_m: unknown, work: () => Promise<unknown>) => work(),
    } as unknown as UnitOfWork;
    const ownShareCheck = new OwnSavedFilterShareCheck(gate);
    const base = { unitOfWork, sellerSavedFilters: repo, ownShareCheck };
    const create = new OwnSavedFilterCreate(gate, { ...base, audit, clock, ids });
    const update = new OwnSavedFilterUpdate(gate, { ...base, audit, clock });
    const remove = new OwnSavedFilterDelete(gate, { ...base, audit });
    const list = new OwnSavedFiltersList(gate, base);
    const body = {
      listKey: 'seller.catalog.products',
      name: 'Live',
      visibility: 'me',
      payload: { v: 1 },
    };

    afterEach(() => {
      acting.value = false;
    });

    it('refuses create, update and delete, writes nothing and still lets the list be read', async () => {
      const made = await create.execute(context, body);
      if (!made.ok) throw new Error('expected the filter to be saved outside the session');
      const { id } = made.value;
      acting.value = true;

      const refused = { ok: false, error: { code: 'access.acting-as-refused' } };
      expect(await create.execute(context, { ...body, name: 'Other' })).toEqual(refused);
      expect(await update.execute(context, { id, name: 'X', visibility: 'me' })).toEqual(refused);
      expect(await remove.execute(context, { id })).toEqual(refused);

      expect([...repo.rows.values()].map((row) => row.name)).toEqual(['Live']);
      expect(audits).toEqual([]);
      expect(await list.execute(context, { listKey: body.listKey })).toMatchObject({
        ok: true,
        value: { items: [{ name: 'Live' }] },
      });
    });
  },
);
