import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Result,
} from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryCategoryEditStore,
  MemoryTreeVersion,
} from '../../../../../test/support/catalog-category-editor-fakes';
import { MemorySellerCategoryStore } from '../../../../../test/support/catalog-seller-category-fakes';
import { fakeRunOnce } from '../../../../../test/support/fake-run-once';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import type { EventDelivery } from '../../../../platform/events/event-delivery';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import {
  CATALOG_CATEGORY_PROPOSAL_DECIDE,
  CATALOG_OWN_CATEGORY_PROPOSE,
  CATALOG_OWN_PRODUCT_EDIT,
  CATALOG_SELLER_CATEGORY_PROMOTE_MERGE,
} from '../../contracts/permissions';
import type { EditableCategory } from '../../domain/category-edit';
import { normaliseShelfName, shelfSlugBase } from '../../domain/seller-category';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { PlatformCategoryRepository } from '../ports/platform-category.repository';
import type { RateCounterRepository } from '../ports/rate-counter.repository';
import { CancelPendingProposals } from './cancel-pending-proposals.use-case';
import { CategoryProposalApprove } from './category-proposal-approve.use-case';
import { CategoryProposalList } from './category-proposal-list.use-case';
import { CategoryProposalReject } from './category-proposal-reject.use-case';
import { OwnCategoryProposalCancel } from './own-category-proposal-cancel.use-case';
import { OwnCategoryProposalsList } from './own-category-proposals-list.use-case';
import { OwnCategoryPropose } from './own-category-propose.use-case';
import { ContentFilter } from '../../../../platform/content-filter/content-filter';
import { OwnOfferSetShelf } from './own-offer-set-shelf.use-case';
import { SellerCategoryMerge } from './seller-category-merge.use-case';
import { SellerCategoryPromote } from './seller-category-promote.use-case';

// Seller category proposals and shelves in memory (categories C9a; CAT-51 to CAT-54), on both
// Market fixtures: the session seller only; `mayProposeCategories` asked at every command and
// again at approval, anything but yes refusing (Hassan M1, I3); eligibility; the claim-text check
// per locale, failing closed; the soft pending cap from Market configuration; duplicates after
// normalisation; a shelf on an Offer only from the Offer's seller; revocation cancels the pending
// proposals; promote creates a hidden platform node with the shelf's id and the tree rules;
// merge clears the shelf on the Offers. The SQL is in test/db/catalog-seller-categories.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-06T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SELLER = '01990000-0000-7000-8000-0000000000b1' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000b2' as Id<'Seller'>;
const SELLER_ACCOUNT = '01990000-0000-7000-8000-0000000000c1' as Id<'Account'>;
const OTHER_ACCOUNT = '01990000-0000-7000-8000-0000000000c2' as Id<'Account'>;

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xd00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
const offerId = (n: number): Id<'Offer'> =>
  `01990000-0000-7000-8000-${(0xe00 + n).toString(16).padStart(12, '0')}` as Id<'Offer'>;

describe.each(['AU', 'ZZ'] as const)('seller category use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const defaultLocale = locales.default;
  const second = locales.supported.find((locale) => locale !== defaultLocale) ?? null;
  const maxDepth = policy.maxCategoryDepth(market);
  const maxPending = policy.maxPendingCategoryProposals(market);

  const sellerContext = (sellerId = SELLER, accountId = SELLER_ACCOUNT): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: accountId,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId: sellerId,
      }),
    );
  const adminContext = (): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: '01990000-0000-7000-8000-0000000000a3' as never,
        sellerId: null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = adminContext();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let shelves: MemorySellerCategoryStore;
  let tree: MemoryCategoryEditStore;
  let treeVersion: MemoryTreeVersion;
  let audits: AuditEntry[];
  let events: PendingEvent[];
  let allowed: Set<string>;
  let mayPropose: Map<string, boolean>;
  let eligible: boolean;
  let covered: Result<readonly string[], { code: 'claim-text.check-unavailable' }>;
  let matcherDown: boolean;
  let reserved: number;
  let capabilityAsks: number;
  let ids: SequenceIdGenerator;
  const clock = new FixedClock(T0);
  const englishVocabulary = code === 'AU' ? 'en-AU' : 'en-US';

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => allowed.has(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const run = async <T, E>(work: () => Promise<Result<T, E>>) => {
    const rollback = shelves.snapshot();
    const savedRows = new Map(tree.rows);
    const savedVersion = treeVersion.version;
    const savedAudits = audits.length;
    const savedEvents = events.length;
    const undo = (): void => {
      rollback();
      tree.rows = savedRows;
      treeVersion.version = savedVersion;
      audits.length = savedAudits;
      events.length = savedEvents;
    };
    try {
      const result = await work();
      if (!result.ok) undo();
      return result;
    } catch (error) {
      undo();
      throw error;
    }
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => run(work),
    runOnce: fakeRunOnce(),
  };
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) =>
      Promise.resolve(
        matcherDown
          ? err({ code: 'claim-text.check-unavailable' })
          : ok(
              texts.map((t) =>
                /halal/i.test(t.text)
                  ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
                  : [],
              ),
            ),
      ),
  };
  const claimLocales: ClaimTermLocales = { covered: () => Promise.resolve(covered) };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const outbox = {
    append: (_c: CallContext, batch: readonly PendingEvent[]) => {
      events.push(...batch);
      return Promise.resolve();
    },
  };
  const counters = {
    reserve: (
      _m: MarketContext,
      asked: readonly { limit: { kind: string } }[],
      now: Temporal.Instant,
    ) => {
      reserved += 1;
      return Promise.resolve(
        asked.map((counter) => ({
          kind: counter.limit.kind,
          count: reserved,
          windowStartedAt: now,
        })),
      );
    },
  } as unknown as RateCounterRepository;
  const counterKeys = { keyOf: () => new Uint8Array([1]) };
  const capability = {
    allows: (_c: CallContext, sellerId: Id<'Seller'>) => {
      capabilityAsks += 1;
      return Promise.resolve(mayPropose.get(sellerId) === true);
    },
  };

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const write = { unitOfWork, shelves, audit, outbox, clock, ids };
    const texts = { policy, matcher, claimLocales, contentFilter: new ContentFilter(markets) };
    return {
      propose: new OwnCategoryPropose(gate, {
        ...write,
        ...texts,
        capability,
        proposalPolicy: { maxPending: (m) => policy.maxPendingCategoryProposals(m) },
        eligibility: { isEligible: () => Promise.resolve(eligible) },
        counters,
        counterKeys,
      }),
      cancel: new OwnCategoryProposalCancel(gate, write),
      own: new OwnCategoryProposalsList(gate, {
        unitOfWork,
        shelves,
        capability,
        proposalPolicy: { maxPending: (m) => policy.maxPendingCategoryProposals(m) },
      }),
      queue: new CategoryProposalList(gate, {
        unitOfWork,
        shelves,
        sellerNames: {
          storeNames: (_c, sellerIds) =>
            Promise.resolve(
              new Map(sellerIds.filter((id) => id === SELLER).map((id) => [id, 'Shop'])),
            ),
        },
      }),
      approve: new CategoryProposalApprove(gate, { ...write, capability, policy }),
      reject: new CategoryProposalReject(gate, write),
      revoke: new CancelPendingProposals(gate, write),
      setShelf: new OwnOfferSetShelf(gate, { unitOfWork, shelves, clock }),
      merge: new SellerCategoryMerge(gate, write),
      promote: new SellerCategoryPromote(gate, {
        ...write,
        ...texts,
        store: tree,
        categories: treeVersion as unknown as PlatformCategoryRepository,
      }),
    };
  };

  const node = (n: number, parent: number | null): EditableCategory => ({
    id: cat(n),
    parentId: parent === null ? null : cat(parent),
    slug: `c${n}`,
    status: 'active',
    hiddenById: null,
    position: n,
    version: 1,
    revisionNo: 1,
    createdByKind: 'admin',
    showInMenu: true,
    imageId: null,
    seo: { title: null, description: null, noindex: false },
    texts: [{ locale: defaultLocale, name: `Category ${n}`, shortDescription: null, keywords: [] }],
  });
  /** A chain of platform categories 1 → 2 → … → depth, all live. */
  const chain = (depth: number): void => {
    for (let n = 1; n <= depth; n += 1) {
      tree.put(node(n, n === 1 ? null : n - 1));
      shelves.platform.set(cat(n), 'active');
    }
  };
  const body = (name: string, parent = 2, extra: Record<string, unknown> = {}) => ({
    platformParentId: cat(parent),
    texts: { [defaultLocale]: { name, ...extra } },
  });
  const proposeOk = async (name: string, parent = 2, sellerId = SELLER) => {
    const answer = await build().propose.execute(sellerContext(sellerId), body(name, parent));
    if (!answer.ok) throw new Error(`propose refused: ${answer.error.code}`);
    return answer.value.proposalId as Id<'CategoryProposal'>;
  };
  const approveOk = async (proposalId: Id<'CategoryProposal'>) => {
    const answer = await build().approve.execute(adminContext(), {
      proposalId,
      body: { version: 1 },
    });
    if (!answer.ok) throw new Error(`approve refused: ${answer.error.code}`);
    return answer.value;
  };

  beforeEach(() => {
    shelves = new MemorySellerCategoryStore();
    tree = new MemoryCategoryEditStore();
    treeVersion = new MemoryTreeVersion();
    audits = [];
    events = [];
    allowed = new Set([
      CATALOG_OWN_CATEGORY_PROPOSE.key,
      CATALOG_OWN_PRODUCT_EDIT.key,
      CATALOG_CATEGORY_PROPOSAL_DECIDE.key,
      CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key,
    ]);
    mayPropose = new Map([
      [SELLER, true],
      [OTHER_SELLER, true],
    ]);
    eligible = true;
    covered = ok([...new Set([...locales.supported, englishVocabulary])]);
    matcherDown = false;
    reserved = 0;
    capabilityAsks = 0;
    ids = new SequenceIdGenerator(clock);
    chain(maxDepth);
  });

  describe('access declarations', () => {
    it('names each use case after its file and keeps the keys of catalog design 6.1', () => {
      const expected = new Map<unknown, [string, string]>([
        [OwnCategoryPropose, ['catalog.own-category-propose', CATALOG_OWN_CATEGORY_PROPOSE.key]],
        [
          OwnCategoryProposalCancel,
          ['catalog.own-category-proposal-cancel', CATALOG_OWN_CATEGORY_PROPOSE.key],
        ],
        [
          OwnCategoryProposalsList,
          ['catalog.own-category-proposals-list', CATALOG_OWN_CATEGORY_PROPOSE.key],
        ],
        [
          CategoryProposalApprove,
          ['catalog.category-proposal-approve', CATALOG_CATEGORY_PROPOSAL_DECIDE.key],
        ],
        [
          CategoryProposalReject,
          ['catalog.category-proposal-reject', CATALOG_CATEGORY_PROPOSAL_DECIDE.key],
        ],
        [
          CategoryProposalList,
          ['catalog.category-proposal-list', CATALOG_CATEGORY_PROPOSAL_DECIDE.key],
        ],
        [
          SellerCategoryPromote,
          ['catalog.seller-category-promote', CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key],
        ],
        [
          SellerCategoryMerge,
          ['catalog.seller-category-merge', CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key],
        ],
        [OwnOfferSetShelf, ['catalog.own-offer-set-shelf', CATALOG_OWN_PRODUCT_EDIT.key]],
      ]);
      for (const [useCase, [name, key]] of expected) {
        const { access } = useCase as { access: { name: string; rule: unknown } };
        expect(access.name).toBe(name);
        expect(access.rule).toEqual({ kind: 'permissions', allOf: [key] });
      }
      expect(CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.protected).toBe(true);
      expect(CATALOG_CATEGORY_PROPOSAL_DECIDE.protected).toBe(false);
      expect(
        (CancelPendingProposals as unknown as { access: { rule: unknown } }).access.rule,
      ).toEqual({ kind: 'system' });
    });
  });

  describe('own-category.propose', () => {
    it('stores a pending proposal of the session seller, with one audit row and one event', async () => {
      const answer = await build().propose.execute(sellerContext(), body('Spices', 2));
      expect(answer.ok).toBe(true);
      const id = answer.ok ? answer.value.proposalId : '';
      const stored = shelves.proposals.get(id);
      expect(stored?.view).toMatchObject({
        sellerId: SELLER,
        platformParentId: cat(2),
        status: 'pending',
        version: 1,
      });
      expect(stored?.normalisedName).toBe('spices');
      expect(audits.map((entry) => entry.action)).toEqual(['catalog.category-proposal.proposed']);
      expect(events.map((event) => [event.type, event.payload])).toEqual([
        ['catalog.category-proposed.v1', { proposalId: id, sellerId: SELLER }],
      ]);
    });

    it('takes the seller from the session only: a seller id in the body is refused', async () => {
      const answer = await build().propose.execute(sellerContext(), {
        ...body('Spices'),
        sellerId: OTHER_SELLER,
      });
      expect(answer).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'sellerId', code: 'unknown' }] }),
      );
      expect(shelves.proposals.size).toBe(0);
    });

    it("refuses a term of the Market's content filter, naming the paths and never the words", async () => {
      const bad = code === 'AU' ? 'shit' : 'zzbad';
      const answer = await build().propose.execute(sellerContext(), {
        ...body('Spices'),
        texts: { [defaultLocale]: { name: `${bad} spices`, shortDescription: `so ${bad}` } },
      });
      expect(answer).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: `texts.${defaultLocale}.name`, code: 'blocked-term' },
            { path: `texts.${defaultLocale}.shortDescription`, code: 'blocked-term' },
          ],
        }),
      );
      expect(shelves.proposals.size).toBe(0);
      expect(audits).toEqual([]);
    });

    it('refuses a caller without the key and an admin session', async () => {
      allowed.delete(CATALOG_OWN_CATEGORY_PROPOSE.key);
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({ code: 'access.denied' }),
      );
      allowed.add(CATALOG_OWN_CATEGORY_PROPOSE.key);
      expect(await build().propose.execute(adminContext(), body('Spices'))).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(shelves.proposals.size).toBe(0);
    });

    it('refuses when mayProposeCategories is not yes, at every command (SEL-26)', async () => {
      mayPropose.set(SELLER, false);
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({ code: 'category-proposal.not-allowed' }),
      );
      mayPropose.set(SELLER, true);
      await proposeOk('Spices');
      await proposeOk('Teas');
      expect(capabilityAsks).toBe(3);
    });

    it('refuses a seller who may not sell', async () => {
      eligible = false;
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({ code: 'seller.not-eligible' }),
      );
    });

    it('claim-checks every name and description in its own locale and fails closed', async () => {
      expect(
        await build().propose.execute(
          sellerContext(),
          body('Spices', 2, { shortDescription: 'Halal only' }),
        ),
      ).toEqual(
        err({
          code: 'category.claim-word',
          fields: [{ path: `texts.${defaultLocale}.shortDescription`, code: 'claim-word' }],
        }),
      );
      matcherDown = true;
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      matcherDown = false;
      covered = ok([englishVocabulary === defaultLocale ? 'xx-XX' : englishVocabulary]);
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({
          code: 'category.locale-uncheckable',
          fields: [{ path: `texts.${defaultLocale}.name`, code: 'locale-uncheckable' }],
        }),
      );
      covered = err({ code: 'claim-text.check-unavailable' });
      expect(await build().propose.execute(sellerContext(), body('Spices'))).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      expect(shelves.proposals.size).toBe(0);
    });

    if (second !== null) {
      it('checks a second locale with its own vocabulary', async () => {
        const answer = await build().propose.execute(sellerContext(), {
          platformParentId: cat(2),
          texts: { [defaultLocale]: { name: 'Spices' }, [second]: { name: 'Halal spices' } },
        });
        expect(answer).toEqual(
          err({
            code: 'category.claim-word',
            fields: [{ path: `texts.${second}.name`, code: 'claim-word' }],
          }),
        );
      });
    }

    it('needs the default locale name and refuses keywords', async () => {
      const missing = await build().propose.execute(sellerContext(), {
        platformParentId: cat(2),
        texts: {},
      });
      expect(missing).toEqual(
        err({
          code: 'category.required-locale-missing',
          fields: [{ path: `texts.${defaultLocale}.name`, code: 'required' }],
        }),
      );
      expect(
        await build().propose.execute(sellerContext(), body('Spices', 2, { keywords: ['a'] })),
      ).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: `texts.${defaultLocale}.keywords`, code: 'unknown' }],
        }),
      );
    });

    it(`keeps the soft pending cap of the Market (${code})`, async () => {
      for (let n = 0; n < maxPending; n += 1) await proposeOk(`Shelf ${n}`);
      expect(await build().propose.execute(sellerContext(), body('One more'))).toEqual(
        err({ code: 'category-proposal.limit', max: maxPending }),
      );
      // Another seller has a cap of their own.
      await proposeOk('One more', 2, OTHER_SELLER);
    });

    it('refuses a duplicate after normalisation: case, white space, Arabic and Persian yeh and kaf', async () => {
      await proposeOk('علي  كتاب');
      expect(await build().propose.execute(sellerContext(), body('علی کتاب'))).toEqual(
        err({ code: 'category-proposal.duplicate' }),
      );
      await proposeOk('Dried Fruit');
      expect(await build().propose.execute(sellerContext(), body('dried   FRUIT'))).toEqual(
        err({ code: 'category-proposal.duplicate' }),
      );
      // Under another parent, or by another seller, the same name is a new proposal.
      await proposeOk('Dried Fruit', 1);
      await proposeOk('Dried Fruit', 2, OTHER_SELLER);
    });

    it('refuses a name that is already a live shelf of the seller under that parent', async () => {
      const id = await proposeOk('Dried Fruit');
      await approveOk(id);
      expect(await build().propose.execute(sellerContext(), body('dried fruit'))).toEqual(
        err({ code: 'category-proposal.duplicate' }),
      );
    });

    it('refuses an unknown or archived parent', async () => {
      expect(await build().propose.execute(sellerContext(), body('Spices', 99))).toEqual(
        err({ code: 'category.parent-not-found' }),
      );
      shelves.platform.set(cat(2), 'archived');
      expect(await build().propose.execute(sellerContext(), body('Spices', 2))).toEqual(
        err({ code: 'category.parent-not-found' }),
      );
    });

    it('counts a claim-refused attempt against the daily limit, and proposes under the seller lock', async () => {
      const before = reserved;
      await build().propose.execute(sellerContext(), body('Halal spices'));
      expect(reserved).toBe(before + 1);
      expect(shelves.proposals.size).toBe(0);
      expect(shelves.locks).toEqual([]);
      expect((await build().propose.execute(sellerContext(), body('Spices'))).ok).toBe(true);
      expect(shelves.locks).toEqual([SELLER]);
    });

    it('refuses a name that normalisation widens past 120 characters, before any write', async () => {
      // U+FDFA is one character that NFKC turns into eighteen.
      const answer = await build().propose.execute(sellerContext(), body('\uFDFA'.repeat(10)));
      expect(answer).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: `texts.${defaultLocale}.name`, code: 'too-long' }],
        }),
      );
      expect(shelves.proposals.size).toBe(0);
    });

    it('throttles more than 20 proposals a day', async () => {
      reserved = 20;
      const answer = await build().propose.execute(sellerContext(), body('Spices'));
      expect(answer.ok ? null : answer.error.code).toBe('request.throttled');
    });
  });

  describe('own-category-proposal.cancel and the seller list', () => {
    it('withdraws only the seller’s own pending proposal at the version read', async () => {
      const id = await proposeOk('Spices');
      expect(
        await build().cancel.execute(sellerContext(OTHER_SELLER, OTHER_ACCOUNT), {
          proposalId: id,
          body: { version: 1 },
        }),
      ).toEqual(err({ code: 'category-proposal.not-found' }));
      expect(
        await build().cancel.execute(sellerContext(), { proposalId: id, body: { version: 2 } }),
      ).toEqual(err({ code: 'conflict.stale' }));
      expect(
        await build().cancel.execute(sellerContext(), { proposalId: id, body: { version: 1 } }),
      ).toEqual(ok({ status: 'cancelled', version: 2 }));
      expect(shelves.proposals.get(id)?.view.reasonCode).toBe('seller-cancelled');
      expect(events.at(-1)?.payload).toEqual({
        proposalId: id,
        sellerId: SELLER,
        reasonCode: 'seller-cancelled',
      });
      expect(
        await build().cancel.execute(sellerContext(), { proposalId: id, body: { version: 2 } }),
      ).toEqual(err({ code: 'category-proposal.not-pending' }));
    });

    it('lists the seller’s own proposals and shelves, and whether they may propose', async () => {
      await proposeOk('Spices');
      await proposeOk('Teas', 2, OTHER_SELLER);
      mayPropose.set(SELLER, false);
      const answer = await build().own.execute(sellerContext(), {});
      expect(answer.ok && answer.value.canPropose).toBe(false);
      expect(answer.ok && answer.value.maxPending).toBe(maxPending);
      expect(answer.ok && answer.value.proposals.map((p) => p.sellerId)).toEqual([SELLER]);
    });
  });

  describe('category-proposal.approve and .reject', () => {
    it('creates a seller shelf, never a platform category, with one audit row and one event', async () => {
      const id = await proposeOk('Dried Fruit');
      const platformBefore = tree.rows.size;
      events = [];
      audits = [];
      const answer = await approveOk(id);
      expect(answer).toMatchObject({ status: 'approved', version: 2, slug: 'dried-fruit' });
      const shelf = shelves.shelves.get(answer.sellerCategoryId);
      expect(shelf).toMatchObject({ sellerId: SELLER, platformParentId: cat(2), status: 'active' });
      expect(tree.rows.size).toBe(platformBefore);
      expect(audits.map((entry) => entry.action)).toEqual(['catalog.category-proposal.approved']);
      expect(events.map((event) => event.type)).toEqual(['catalog.category-proposal-approved.v1']);
    });

    it('asks mayProposeCategories again: revoked between propose and approve refuses (Hassan M1)', async () => {
      const id = await proposeOk('Spices');
      mayPropose.set(SELLER, false);
      expect(
        await build().approve.execute(adminContext(), { proposalId: id, body: { version: 1 } }),
      ).toEqual(err({ code: 'category-proposal.not-allowed' }));
      expect(shelves.proposals.get(id)?.view.status).toBe('pending');
      expect(shelves.shelves.size).toBe(0);
    });

    it('refuses a seller session and an acting-as session', async () => {
      const id = await proposeOk('Spices');
      for (const context of [sellerContext(), actingAs()]) {
        expect(
          await build().approve.execute(context, { proposalId: id, body: { version: 1 } }),
        ).toEqual(err({ code: 'access.denied' }));
      }
    });

    it('gives each shelf of the seller its own slug', async () => {
      const first = await approveOk(await proposeOk('Dried Fruit', 2));
      const second = await approveOk(await proposeOk('Dried Fruit', 1));
      expect([first.slug, second.slug]).toEqual(['dried-fruit', 'dried-fruit-2']);
      expect(shelfSlugBase('خشکبار')).toBe('shelf');
      expect(normaliseShelfName(' Ｄried Fruit ')).toBe('dried fruit');
    });

    it('rejects with a prepared reason only', async () => {
      const id = await proposeOk('Spices');
      expect(
        await build().reject.execute(adminContext(), {
          proposalId: id,
          body: { version: 1, reasonCode: 'because' },
        }),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'unknown' }] }),
      );
      expect(
        await build().reject.execute(adminContext(), {
          proposalId: id,
          body: { version: 1, reasonCode: 'too-narrow' },
        }),
      ).toEqual(ok({ status: 'rejected', version: 2 }));
      expect(
        await build().approve.execute(adminContext(), { proposalId: id, body: { version: 2 } }),
      ).toEqual(err({ code: 'category-proposal.not-pending' }));
    });

    it('lists the waiting proposals oldest first with the store names it can find', async () => {
      await proposeOk('Spices');
      await proposeOk('Teas', 2, OTHER_SELLER);
      const answer = await build().queue.execute(adminContext(), { limit: 1 });
      expect(answer.ok && answer.value.items.map((item) => item.storeName)).toEqual(['Shop']);
      const next = answer.ok ? answer.value.nextAfterId : null;
      const page2 = await build().queue.execute(adminContext(), { afterId: next, limit: 1 });
      expect(page2.ok && page2.value.items.map((item) => [item.sellerId, item.storeName])).toEqual([
        [OTHER_SELLER, null],
      ]);
    });
  });

  describe('sellers.category-proposals-revoked.v1', () => {
    const delivery = (n: number): EventDelivery => ({
      eventId: `0192b3c4-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'event'>,
      subscriber: 'catalog.cancel-pending-proposals-on-revoked',
      attempt: 1,
    });

    it('cancels every pending proposal of the seller, once, and nothing else', async () => {
      const a = await proposeOk('Spices');
      const b = await proposeOk('Teas');
      const approved = await proposeOk('Rice');
      await approveOk(approved);
      const other = await proposeOk('Spices', 2, OTHER_SELLER);
      events = [];
      const system = testCallContext(market, 'system');
      expect(
        await build().revoke.execute(system, { delivery: delivery(1), sellerId: SELLER }),
      ).toEqual(ok({ code: 'catalog.category-proposals-cancelled', count: 2 }));
      expect([a, b].map((id) => shelves.proposals.get(id)?.view.reasonCode)).toEqual([
        'permission-revoked',
        'permission-revoked',
      ]);
      expect(shelves.proposals.get(approved)?.view.status).toBe('approved');
      expect(shelves.proposals.get(other)?.view.status).toBe('pending');
      expect(events.map((event) => event.aggregateVersion)).toEqual([2, 2]);
      expect(
        await build().revoke.execute(system, { delivery: delivery(1), sellerId: SELLER }),
      ).toEqual(ok({ code: 'catalog.category-proposals.already-handled' }));
      expect(
        await build().revoke.execute(adminContext(), { delivery: delivery(2), sellerId: SELLER }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('own-offer.set-shelf', () => {
    beforeEach(() => {
      shelves.offers.set(offerId(1), {
        id: offerId(1),
        sellerId: SELLER,
        shelfId: null,
        version: 3,
        deleted: false,
      });
      shelves.offers.set(offerId(2), {
        id: offerId(2),
        sellerId: OTHER_SELLER,
        shelfId: null,
        version: 1,
        deleted: false,
      });
    });

    it('puts the seller’s Offer on the seller’s own active shelf and takes it off', async () => {
      const shelf = (await approveOk(await proposeOk('Spices'))).sellerCategoryId;
      expect(
        await build().setShelf.execute(sellerContext(), {
          offerId: offerId(1),
          body: { shelfId: shelf, version: 3 },
        }),
      ).toEqual(ok({ version: 4 }));
      expect(shelves.offers.get(offerId(1))?.shelfId).toBe(shelf);
      expect(
        await build().setShelf.execute(sellerContext(), {
          offerId: offerId(1),
          body: { shelfId: null, version: 4 },
        }),
      ).toEqual(ok({ version: 5 }));
      expect(shelves.history.map((row) => row.actor.kind)).toEqual(['seller', 'seller']);
    });

    it('never puts an Offer on another seller’s shelf, nor a shelf on another seller’s Offer', async () => {
      const otherShelf = (await approveOk(await proposeOk('Teas', 2, OTHER_SELLER)))
        .sellerCategoryId;
      expect(
        await build().setShelf.execute(sellerContext(), {
          offerId: offerId(1),
          body: { shelfId: otherShelf, version: 3 },
        }),
      ).toEqual(err({ code: 'seller-category.not-found' }));
      const own = (await approveOk(await proposeOk('Spices'))).sellerCategoryId;
      expect(
        await build().setShelf.execute(sellerContext(), {
          offerId: offerId(2),
          body: { shelfId: own, version: 1 },
        }),
      ).toEqual(err({ code: 'offer.not-found' }));
      expect(
        await build().setShelf.execute(sellerContext(), {
          offerId: offerId(1),
          body: { shelfId: own, version: 1 },
        }),
      ).toEqual(err({ code: 'conflict.stale' }));
    });
  });

  describe('seller-category.merge and .promote', () => {
    let shelf: Id<'SellerCategory'>;
    beforeEach(async () => {
      shelf = (await approveOk(await proposeOk('Dried Fruit', maxDepth - 1)))
        .sellerCategoryId as Id<'SellerCategory'>;
      shelves.offers.set(offerId(1), {
        id: offerId(1),
        sellerId: SELLER,
        shelfId: shelf,
        version: 1,
        deleted: false,
      });
      events = [];
      audits = [];
    });

    it('merge closes the shelf and clears it on the Offers, never moving it', async () => {
      expect(
        await build().merge.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, categoryId: cat(maxDepth) },
        }),
      ).toEqual(ok({ status: 'merged', mergedIntoId: cat(maxDepth), offersCleared: 1 }));
      expect(shelves.shelves.get(shelf)).toMatchObject({
        status: 'merged',
        mergedIntoId: cat(maxDepth),
      });
      expect(shelves.offers.get(offerId(1))).toMatchObject({ shelfId: null, version: 2 });
      expect(shelves.history.at(-1)).toMatchObject({ kind: 'shelf-cleared' });
      expect(audits.map((entry) => entry.action)).toEqual(['catalog.seller-category.merged']);
      expect(events.map((event) => event.type)).toEqual(['catalog.seller-category-merged.v1']);
      // Terminal.
      expect(
        await build().merge.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 2, categoryId: cat(1) },
        }),
      ).toEqual(err({ code: 'seller-category.not-active' }));
    });

    it('merge refuses an unknown target and needs the protected key', async () => {
      expect(
        await build().merge.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, categoryId: cat(99) },
        }),
      ).toEqual(err({ code: 'category.not-found' }));
      allowed.delete(CATALOG_SELLER_CATEGORY_PROMOTE_MERGE.key);
      expect(
        await build().merge.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, categoryId: cat(1) },
        }),
      ).toEqual(err({ code: 'access.denied' }));
    });

    it('promote puts a hidden platform category with the shelf’s id into the tree', async () => {
      // The shelf hangs under level maxDepth - 1, so it lands on the deepest level.
      const answer = await build().promote.execute(adminContext(), {
        shelfId: shelf,
        body: { version: 1, slug: 'dried-fruit', treeVersion: 1 },
      });
      expect(answer).toEqual(
        ok({
          categoryId: shelf,
          slug: 'dried-fruit',
          status: 'hidden',
          treeVersion: 2,
          offersCleared: 1,
        }),
      );
      expect(tree.rows.get(shelf)).toMatchObject({ parentId: cat(maxDepth - 1), status: 'hidden' });
      expect(shelves.shelves.get(shelf)?.status).toBe('promoted');
      expect(shelves.offers.get(offerId(1))?.shelfId).toBeNull();
      expect(events.map((event) => event.type)).toEqual([
        'catalog.seller-category-promoted.v1',
        'catalog.platform-category-created.v1',
      ]);
    });

    it("promote refuses a shelf text that holds a term of the Market's content filter", async () => {
      const bad = code === 'AU' ? 'shit' : 'zzbad';
      const stored = shelves.shelves.get(shelf)!;
      shelves.shelves.set(shelf, {
        ...stored,
        texts: stored.texts.map((text) => ({ ...text, name: `${bad} fruit` })),
      });
      const answer = await build().promote.execute(adminContext(), {
        shelfId: shelf,
        body: { version: 1, slug: 'dried-fruit', treeVersion: 1 },
      });
      expect(answer.ok ? null : answer.error).toMatchObject({ code: 'validation.failed' });
      expect(shelves.shelves.get(shelf)?.status).toBe('active');
      expect(tree.rows.has(shelf)).toBe(false);
    });

    it('promote keeps the tree rules: depth, slug, claim words, tree version', async () => {
      const deep = (await approveOk(await proposeOk('Deep', maxDepth))).sellerCategoryId;
      expect(
        await build().promote.execute(adminContext(), {
          shelfId: deep,
          body: { version: 1, slug: 'deep', treeVersion: 1 },
        }),
      ).toEqual(err({ code: 'category.depth-exceeded', max: maxDepth }));
      expect(
        await build().promote.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, slug: 'c1', treeVersion: 1 },
        }),
      ).toEqual(err({ code: 'category.slug-taken' }));
      expect(
        await build().promote.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, slug: 'halal-fruit', treeVersion: 1 },
        }),
      ).toEqual(
        err({ code: 'category.claim-word', fields: [{ path: 'slug', code: 'claim-word' }] }),
      );
      expect(
        await build().promote.execute(adminContext(), {
          shelfId: shelf,
          body: { version: 1, slug: 'dried-fruit', treeVersion: 7 },
        }),
      ).toEqual(err({ code: 'conflict.stale' }));
      expect(shelves.shelves.get(shelf)?.status).toBe('active');
      expect(
        await build().promote.execute(actingAs(), {
          shelfId: shelf,
          body: { version: 1, slug: 'dried-fruit', treeVersion: 1 },
        }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });
});
