import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
} from '../../../../../test/support/catalog-attribute-admin-fakes';
import {
  MemoryFeatureSetStore,
  claimLocalesOf,
  halalOnlyMatcher,
} from '../../../../../test/support/catalog-attribute-editor-fakes';
import {
  applied,
  RecordingProposer,
  RecordingReview,
} from '../../../../../test/support/system-request-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import {
  FeatureSetCreateApplier,
  type CatalogueStructureDependencies,
} from '../catalogue-appliers';
import { FeatureSetCreate } from './feature-set-create.use-case';

// A new feature set waits for a second admin's approval where the Market reviews area catalogue
// (owner decision of 18 Nov 2026; a feature set has no delete, so its create cannot be undone by a
// reviewer). On both Market fixtures: the proposal writes nothing, the approval creates it with the
// same checks, a code taken since is `changed-since`, a claim word added to the checker since is
// `not-permitted`, a reject changes nothing and an area that is off creates it at once.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-18T10:00:00Z');
const ID = (n: number) => `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const NO_REQUEST = ID(0x5eff) as never;

describe.each(['AU', 'ZZ'] as const)(
  'feature-set create (system requests) in market %s',
  (code) => {
    const market: MarketContext = testMarketContext(code, 'default');
    const locales = policy.locales(market);
    const locale = locales.default;

    const admin = (account = 0xa1, actingAs = false): CallContext => {
      const base = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: ID(account) as never,
          sessionId: ID(account + 0x100) as never,
          sellerId: null,
        }),
      );
      return actingAs
        ? { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ID(account) } } as never }
        : base;
    };

    let store: MemoryFeatureSetStore;
    let reader: MemoryAttributeAdminReader;
    let review: RecordingReview;
    let proposer: RecordingProposer;
    let audits: AuditEntry[];
    let allow: boolean;
    let claimWords: boolean;
    const clock = new FixedClock(T0);

    const check: AuthorisationCheck = {
      check: (_c, declaration) =>
        Promise.resolve(
          allow &&
            declaration.rule.kind === 'permissions' &&
            declaration.rule.allOf.includes(CATALOG_ATTRIBUTE_EDIT.key)
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

    const build = () => {
      const deps = {
        unitOfWork,
        featureSetStore: store,
        attributeAdminReader: reader,
        policy,
        matcher: {
          match: (context: CallContext, texts: Parameters<typeof halalOnlyMatcher.match>[1]) =>
            claimWords
              ? halalOnlyMatcher.match(context, texts)
              : Promise.resolve(ok(texts.map(() => []))),
        },
        claimLocales: claimLocalesOf(locales.supported),
        audit,
        clock,
        ids: new SequenceIdGenerator(clock),
        review,
        proposer,
      };
      const gate = createUseCaseGate(markets, check);
      return {
        create: new FeatureSetCreate(gate, deps),
        applier: new FeatureSetCreateApplier({
          ...deps,
          authorisation: check,
        } as unknown as CatalogueStructureDependencies),
      };
    };

    const body = (extra: Record<string, unknown> = {}) => ({
      names: { [locale]: 'Pantry goods' },
      groups: [
        {
          groupCode: 'core',
          names: { [locale]: 'Core' },
          attributes: [
            { code: 'brand', level: 'required' },
            { code: 'country-of-origin', level: 'recommended' },
          ],
        },
        { names: { [locale]: 'Details' }, attributes: [{ code: 'pack', level: 'optional' }] },
      ],
      ...extra,
    });
    const note = 'A feature set for the pantry aisle.';
    const requestOf = (change: { subjectRef: string; before: unknown; after: unknown }) => ({
      requestId: NO_REQUEST,
      subjectRef: change.subjectRef,
      before: change.before as never,
      after: change.after as never,
    });

    beforeEach(() => {
      store = new MemoryFeatureSetStore();
      reader = new MemoryAttributeAdminReader();
      for (const [n, attribute] of [
        [1, 'brand'],
        [2, 'country-of-origin'],
        [3, 'pack'],
      ] as const) {
        reader.seedDefinition(
          code,
          definitionRecord(ID(0xd00 + n), attribute, { names: { [locale]: attribute } }),
        );
      }
      review = new RecordingReview().review('catalogue');
      proposer = new RecordingProposer(review);
      audits = [];
      allow = true;
      claimWords = true;
    });

    it('files a proposal and writes nothing; the approval creates it as the approving admin', async () => {
      const uc = build();
      const answer = await uc.create.execute(admin(), body({ note }));
      expect(answer).toEqual(ok({ request: <unknown>expect.objectContaining({ number: 901 }) }));
      expect(store.rows.size).toBe(0);
      expect(audits).toEqual([]);
      const proposal = proposer.proposed[0]!;
      expect(proposal).toMatchObject({
        area: 'catalogue',
        subjectKind: 'catalog.feature-set-create',
        subjectRef: 'pantry-goods',
        before: { exists: false },
        after: {
          action: 'create',
          entries: [
            { group: 0, code: 'brand', level: 'required' },
            { group: 0, code: 'country-of-origin', level: 'recommended' },
            { group: 1, code: 'pack', level: 'optional' },
          ],
        },
        note,
      });

      const request = requestOf(proposal);
      expect(await uc.applier.check(admin(0xb1), request)).toBe('ok');
      expect(await uc.applier.apply(admin(0xb1), request)).toBe('applied');
      const created = [...store.rows.values()][0]!.state;
      expect(created).toMatchObject({ code: 'pantry-goods' });
      expect(created.groups.map((g) => g.attributes.map((a) => a.code))).toEqual([
        ['brand', 'country-of-origin'],
        ['pack'],
      ]);
      expect(store.authors.map((a) => a.author)).toEqual([ID(0xb1)]);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ after: { requestId: NO_REQUEST } });
    });

    it('needs a note where the area is reviewed', async () => {
      expect(await build().create.execute(admin(), body())).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'note', code: 'required' }] }),
      );
      expect(proposer.proposed).toEqual([]);
    });

    it('answers changed-since when the code asked for was taken since, writing nothing more', async () => {
      const uc = build();
      await uc.create.execute(admin(), body({ code: 'pantry', note }));
      const request = requestOf(proposer.proposed[0]!);
      review.reset();
      // Another admin created a set with the same code meanwhile (area off for that create).
      const direct = await uc.create.execute(admin(), body({ code: 'pantry' }));
      expect(direct.ok).toBe(true);
      expect(await uc.applier.check(admin(0xb1), request)).toBe('ok');
      expect(await uc.applier.apply(admin(0xb1), request)).toBe('changed-since');
      expect(store.rows.size).toBe(1);
    });

    it('a code made from the name gets a free one at approval, as the route does', async () => {
      const uc = build();
      await uc.create.execute(admin(), body({ note }));
      const request = requestOf(proposer.proposed[0]!);
      review.reset();
      expect((await uc.create.execute(admin(), body())).ok).toBe(true);
      expect(await uc.applier.check(admin(0xb1), request)).toBe('ok');
      expect(await uc.applier.apply(admin(0xb1), request)).toBe('applied');
      expect([...store.rows.values()].map((row) => row.state.code).sort()).toEqual([
        'pantry-goods',
        'pantry-goods-2',
      ]);
    });

    it('fails closed: a claim word, no key, an acting-as session, or the check not run', async () => {
      const uc = build();
      await uc.create.execute(admin(), body({ note }));
      const request = requestOf(proposer.proposed[0]!);
      expect(await uc.applier.apply(admin(0xb1), request)).toBe('not-permitted');
      expect(await uc.applier.check(admin(0xb1, true), request)).toBe('not-permitted');
      allow = false;
      expect(await uc.applier.check(admin(0xb1), request)).toBe('not-permitted');
      allow = true;
      const halal = requestOf({
        ...proposer.proposed[0]!,
        after: { ...proposer.proposed[0]!.after, names: { [locale]: 'Halal pantry' } },
      });
      expect(await uc.applier.check(admin(0xb1), halal)).toBe('not-permitted');
      expect(store.rows.size).toBe(0);
      expect(audits).toEqual([]);
    });

    it('an apply does not reuse a check cleared before a refused one, or for another admin (Hassan L1)', async () => {
      const uc = build();
      await uc.create.execute(admin(), body({ note }));
      const request = requestOf(proposer.proposed[0]!);
      expect(await uc.applier.check(admin(0xb1), request)).toBe('ok');
      allow = false;
      expect(await uc.applier.check(admin(0xb1), request)).toBe('not-permitted');
      allow = true;
      expect(await uc.applier.apply(admin(0xb1), request)).toBe('not-permitted');
      expect(await uc.applier.check(admin(0xb1), request)).toBe('ok');
      expect(await uc.applier.apply(admin(0xb2), request)).toBe('not-permitted');
      expect(store.rows.size).toBe(0);
      expect(audits).toEqual([]);
    });

    it('a reject changes nothing; a second proposal of the code waits for the first', async () => {
      const uc = build();
      await uc.create.execute(admin(), body({ note }));
      expect(await uc.create.execute(admin(), body({ note }))).toEqual(
        err({ code: 'system-requests.already-pending', pendingNumber: 901 }),
      );
      proposer.settle('catalog.feature-set-create', 'pantry-goods');
      expect(store.rows.size).toBe(0);
    });

    it('creates it at once where the area is off', async () => {
      review.reset();
      const answer = await build().create.execute(admin(), body());
      expect(answer.ok && applied(answer.value).featureSet).toMatchObject({ code: 'pantry-goods' });
      expect(proposer.proposed).toEqual([]);
      expect(store.rows.size).toBe(1);
    });
  },
);
