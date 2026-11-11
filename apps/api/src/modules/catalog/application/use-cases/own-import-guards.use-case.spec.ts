import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AccessDeclaration, AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { ImportFileStore } from '../ports/import-file-store';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import { OwnImportDiscard } from './own-import-discard.use-case';
import { OwnImportPurge } from './own-import-purge.use-case';
import { OwnImportRowCreate } from './own-import-row-create.use-case';
import { OwnImportRowOfferCreate } from './own-import-row-offer-create.use-case';
import { OwnImportRowOfferEdit } from './own-import-row-offer-edit.use-case';
import { OwnImportRowSave } from './own-import-row-save.use-case';

// The seller import's guards that need no database (catalog design 14c): the seller scope of a
// job (another seller's id answers the byte-identical `import.not-found`), the acting-as refusal,
// the two keys the row use cases need, and the purge.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-07T10:00:00Z');
const SELLER_A = '01990000-0000-7000-8000-0000000000a1' as Id<'Seller'>;
const SELLER_B = '01990000-0000-7000-8000-0000000000b1' as Id<'Seller'>;
const ACCOUNT_A = '01990000-0000-7000-8000-0000000000a2' as Id<'Account'>;
const ACCOUNT_A2 = '01990000-0000-7000-8000-0000000000a4' as Id<'Account'>;
const SESSION = '01990000-0000-7000-8000-0000000000a3';
const JOB = '01990000-0000-7000-8000-0000000000c1';

const unitOfWork = {
  run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
} as unknown as UnitOfWork;

describe.each(['AU', 'ZZ'] as const)('seller import guards in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  let allowed: boolean;
  const declarations: AccessDeclaration[] = [];
  const check: AuthorisationCheck = {
    check: (_context: CallContext, declaration: AccessDeclaration) => {
      declarations.push(declaration);
      return Promise.resolve(allowed ? { allowed: true } : { allowed: false, reason: 'missing' });
    },
  } as unknown as AuthorisationCheck;
  const gate = createUseCaseGate(markets, check);

  beforeEach(() => {
    allowed = true;
    declarations.length = 0;
  });

  const admin = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ACCOUNT_A,
        sessionId: SESSION as never,
        sellerId: null,
      }),
    );
  const seller = (
    sellerId: Id<'Seller'> = SELLER_A,
    accountId: Id<'Account'> = ACCOUNT_A,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId,
        sessionId: SESSION as never,
        sellerId: sellerId,
      }),
    );
  // An acting-as marker on a minted context: the gate refuses it before the use case runs.
  const actingAs = (): CallContext => {
    const base = seller();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ACCOUNT_A } } as never };
  };

  describe('discard', () => {
    function rig(found: { startedByAccountId: Id<'Account'> } | null) {
      const finds: Id<'Seller'>[] = [];
      const deleted: string[] = [];
      let discards = 0;
      const sellerJobs = {
        find: (_m: MarketContext, sellerId: Id<'Seller'>) => {
          finds.push(sellerId);
          return Promise.resolve(sellerId === SELLER_A ? found : null);
        },
        discard: () => {
          discards += 1;
          return Promise.resolve({ fileKey: 'catalog/seller-imports/key' });
        },
        markFileDeleted: () => Promise.resolve(),
        deleteDiscarded: () => Promise.resolve(1),
      } as unknown as SellerImportRepository;
      const importFiles: ImportFileStore = {
        keyOf: () => 'k',
        put: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        delete: (key) => {
          deleted.push(key);
          return Promise.resolve();
        },
      };
      const useCase = new OwnImportDiscard(gate, {
        unitOfWork,
        sellerJobs,
        importFiles,
        clock: { now: () => T0 },
      });
      return { useCase, finds, deleted, discards: () => discards };
    }

    it('discards the job of the seller and deletes its file', async () => {
      const r = rig({ startedByAccountId: ACCOUNT_A });
      const outcome = await r.useCase.execute(seller(), { importId: JOB });
      expect(outcome).toEqual({ ok: true, value: { discarded: true } });
      expect(r.deleted).toEqual(['catalog/seller-imports/key']);
    });

    it('answers another seller, an unknown id and another account of the seller the same', async () => {
      const mine = rig({ startedByAccountId: ACCOUNT_A });
      const other = await mine.useCase.execute(seller(SELLER_B), { importId: JOB });
      const unknown = await rig(null).useCase.execute(seller(), { importId: JOB });
      const otherAccount = await rig({ startedByAccountId: ACCOUNT_A }).useCase.execute(
        seller(SELLER_A, ACCOUNT_A2),
        { importId: JOB },
      );
      expect(other).toEqual({ ok: false, error: { code: 'import.not-found' } });
      expect(JSON.stringify(unknown)).toBe(JSON.stringify(other));
      expect(JSON.stringify(otherAccount)).toBe(JSON.stringify(other));
      expect(mine.discards()).toBe(0);
      expect(mine.deleted).toEqual([]);
    });

    it('refuses an acting-as session, a non-seller actor and a missing key', async () => {
      const r = rig({ startedByAccountId: ACCOUNT_A });
      expect(await r.useCase.execute(actingAs(), { importId: JOB })).toMatchObject({ ok: false });
      expect(await r.useCase.execute(admin(), { importId: JOB })).toMatchObject({
        ok: false,
        error: { code: 'access.denied' },
      });
      allowed = false;
      expect(await r.useCase.execute(seller(), { importId: JOB })).toMatchObject({ ok: false });
      expect(r.finds).toEqual([]);
      expect(r.discards()).toBe(0);
    });

    it('declares both import keys and denies an unapproved seller', () => {
      expect(OwnImportDiscard.access).toMatchObject({
        rule: { kind: 'permissions' },
        whenSellerNotApproved: 'deny',
      });
    });

    it('refuses a malformed id before any read', async () => {
      const r = rig({ startedByAccountId: ACCOUNT_A });
      const outcome = await r.useCase.execute(seller(), { importId: 'nope' });
      expect(outcome).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(r.finds).toEqual([]);
    });
  });

  describe('row use cases', () => {
    const inner = () => ({ execute: jest.fn(() => Promise.resolve({ ok: true, value: {} })) });

    it.each([
      ['row-create', (i: never) => new OwnImportRowCreate(gate, { create: i })],
      ['row-offer-create', (i: never) => new OwnImportRowOfferCreate(gate, { create: i })],
      ['row-offer-edit', (i: never) => new OwnImportRowOfferEdit(gate, { edit: i })],
    ])(
      '%s needs both keys, refuses acting-as and calls the interactive use case once',
      async (name, build) => {
        const innerCase = inner();
        const useCase = build(innerCase as never) as unknown as {
          execute: (c: CallContext, i: unknown) => Promise<unknown>;
        };
        const declaration = (useCase.constructor as unknown as { access: AccessDeclaration })
          .access;
        expect(declaration.name).toBe(`catalog.own-import-${name}`);
        expect(declaration).toMatchObject({
          rule: {
            kind: 'permissions',
            allOf: ['catalog.own-product.edit', 'catalog.own-import.run'],
          },
          whenSellerNotApproved: 'deny',
        });
        expect(await useCase.execute(actingAs(), {})).toMatchObject({ ok: false });
        expect(await useCase.execute(admin(), {})).toMatchObject({ ok: false });
        expect(innerCase.execute).not.toHaveBeenCalled();
        await useCase.execute(seller(), {});
        expect(innerCase.execute).toHaveBeenCalledTimes(1);
      },
    );

    it('a key taken away stops the row at the gate', async () => {
      const innerCase = inner();
      const useCase = new OwnImportRowCreate(gate, { create: innerCase as never });
      allowed = false;
      expect(await useCase.execute(seller(), {} as never)).toMatchObject({ ok: false });
      expect(innerCase.execute).not.toHaveBeenCalled();
    });

    it('row-save is a use case of its own with the same two keys', () => {
      expect(OwnImportRowSave.access).toMatchObject({
        name: 'catalog.own-import-row-save',
        whenSellerNotApproved: 'deny',
      });
    });
  });

  describe('purge', () => {
    it('runs only as the system actor and deletes a due file before its row', async () => {
      const order: string[] = [];
      let due = 1;
      const sellerJobs = {
        filesDue: () =>
          Promise.resolve(
            due > 0
              ? [{ id: JOB as Id<'SellerImport'>, fileKey: 'catalog/seller-imports/old' }]
              : [],
          ),
        markFileDeleted: () => {
          order.push('mark');
          due = 0;
          return Promise.resolve();
        },
        deleteDiscarded: () => Promise.resolve(0),
        deleteSettledBefore: () => Promise.resolve(0),
      } as unknown as SellerImportRepository;
      const importFiles: ImportFileStore = {
        keyOf: () => 'k',
        put: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        delete: () => {
          order.push('file');
          return Promise.resolve();
        },
      };
      const useCase = new OwnImportPurge(gate, {
        unitOfWork,
        sellerJobs,
        importFiles,
        clock: { now: () => T0 },
      });
      expect(await useCase.execute(seller(), {})).toMatchObject({ ok: false });
      expect(order).toEqual([]);
      const outcome = await useCase.execute(testCallContext(market, 'system'), {});
      expect(outcome).toEqual({ ok: true, value: { filesDeleted: 1, jobsDeleted: 0 } });
      expect(order).toEqual(['file', 'mark']);
    });

    it('leaves the row when the delete of the file fails', async () => {
      const marks: string[] = [];
      const sellerJobs = {
        filesDue: () =>
          Promise.resolve([{ id: JOB as Id<'SellerImport'>, fileKey: 'catalog/seller-imports/x' }]),
        markFileDeleted: () => {
          marks.push('mark');
          return Promise.resolve();
        },
        deleteDiscarded: () => Promise.resolve(0),
        deleteSettledBefore: () => Promise.resolve(0),
      } as unknown as SellerImportRepository;
      const importFiles: ImportFileStore = {
        keyOf: () => 'k',
        put: () => Promise.resolve(),
        get: () => Promise.resolve(null),
        delete: () => Promise.reject(new Error('storage down')),
      };
      const useCase = new OwnImportPurge(gate, {
        unitOfWork,
        sellerJobs,
        importFiles,
        clock: { now: () => T0 },
      });
      const outcome = await useCase.execute(testCallContext(market, 'system'), {});
      expect(outcome).toEqual({ ok: true, value: { filesDeleted: 0, jobsDeleted: 0 } });
      expect(marks).toEqual([]);
    });
  });
});
