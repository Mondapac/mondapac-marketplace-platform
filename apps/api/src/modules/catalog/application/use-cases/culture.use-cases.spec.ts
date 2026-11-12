import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import { cleanClaimTextMatcher } from '../../../../../test/support/clean-claim-text-matcher.fake';
import { unavailableClaimTextMatcher } from '../../../../../test/support/unavailable-claim-text-matcher.fake';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CultureState } from '../../domain/culture';
import type { CultureCategoryRow } from '../../domain/culture-category';
import type { StoredCategoryNode } from '../../domain/category-tree';
import { CheckedInCultureSeed } from '../../infrastructure/seed/checked-in-culture-seed';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { CategoryTreeReader } from '../ports/category-tree.reader';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { CultureMembers } from '../ports/culture-members';
import type { CultureReader } from '../ports/culture.reader';
import type { CultureRepository } from '../ports/culture.repository';
import { CultureCategoryMarkClear } from './culture-category-mark-clear.use-case';
import { CultureCategoryMarkSet } from './culture-category-mark-set.use-case';
import { CultureCategoryMarks } from './culture-category-marks.use-case';
import { CultureCreate } from './culture-create.use-case';
import { CultureEdit } from './culture-edit.use-case';
import { CultureGet } from './culture-get.use-case';
import { CultureList } from './culture-list.use-case';
import { SeedCultures } from './seed-cultures.use-case';

// The culture use cases in memory, on both Market fixtures: required default-locale name and
// description, claim-word refusal (and a matcher that is down fails closed), the required
// certification type check, the default-culture rules, the version check, category marks with
// inheritance, audit rows, the seed, and the admin-only rule. The database behaviour is in test/db.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-11-11T00:00:00Z');

const FIXTURES = [
  { code: 'AU', locales: { default: 'en', supported: ['en', 'ar'] }, type: 'halal' },
  { code: 'ZZ', locales: { default: 'zz', supported: ['zz', 'en'] }, type: 'kosher' },
] as const;

describe.each(FIXTURES)('culture use cases in market $code', ({ code, locales, type }) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const clock = new FixedClock(T0);
  const ids = new SequenceIdGenerator(clock);
  const main = locales.default;
  const second = locales.supported.find((l) => l !== main)!;
  const text = (name: string) => ({ name, description: `About ${name}` });

  const rows = new Map<string, CultureState>();
  const marks = new Map<string, CultureCategoryRow>();
  let audits: AuditEntry[] = [];
  let permissions: string[] = [];
  // The next N saves fail as stale (another writer got in); set when the revert is about to run.
  let staleSaves = 0;
  let staleSavesOnRevert = 0;
  const demoteCalls: string[] = [];
  const cultures: CultureRepository = {
    add: (_m, state) => {
      if ([...rows.values()].some((r) => r.code === state.code)) {
        return Promise.resolve('culture.code-taken');
      }
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
    findById: (_m, id) => Promise.resolve(rows.get(id) ?? null),
    codeTaken: (_m, wanted) => Promise.resolve([...rows.values()].some((r) => r.code === wanted)),
    defaultId: () => Promise.resolve([...rows.values()].find((r) => r.isDefault)?.id ?? null),
    count: () => Promise.resolve(rows.size),
    save: (_m, state, expectedVersion) => {
      if (staleSaves > 0) {
        staleSaves -= 1;
        throw new StaleAggregateError('culture', state.id);
      }
      if (rows.get(state.id)?.version !== expectedVersion) {
        throw new StaleAggregateError('culture', state.id);
      }
      rows.set(state.id, state);
      return Promise.resolve(null);
    },
    clearDefaultExcept: (_m, exceptId) => {
      for (const [key, row] of rows) {
        if (row.isDefault && row.id !== exceptId)
          rows.set(key, { ...row, isDefault: false, version: row.version + 1 });
      }
      return Promise.resolve();
    },
    categoryRows: () => Promise.resolve([...marks.values()]),
    setCategoryRow: (_m, _c, row) => {
      marks.set(row.categoryId, row);
      return Promise.resolve();
    },
    clearCategoryRow: (_m, _c, categoryId) => Promise.resolve(marks.delete(categoryId)),
  };
  const cultureReader: CultureReader = {
    byIds: (_m, ids) => Promise.resolve([...rows.values()].filter((r) => ids.includes(r.id))),
    list: (_m, query) =>
      Promise.resolve(
        [...rows.values()].filter((r) => query.status === null || r.status === query.status),
      ),
  };
  const unitOfWork = {
    run: <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => work(),
  } as unknown as UnitOfWork;
  const policy = {
    locales: () => ({ default: main, supported: [...locales.supported] }),
  } as unknown as CatalogMarketPolicy;
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  let activeTypes: ReadonlySet<string> | null = new Set([type]);
  const evaluator = {
    activeTypeCodes: () =>
      Promise.resolve(
        activeTypes === null ? err({ code: 'claim.check-unavailable' } as const) : ok(activeTypes),
      ),
  } as unknown as ClaimEvaluator;

  const cat = (n: number): Id<'Category'> =>
    `01990000-0000-7000-8000-${(0xc00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;
  const node = (
    n: number,
    parent: Id<'Category'> | null,
    status: StoredCategoryNode['status'] = 'active',
  ): StoredCategoryNode => ({
    id: cat(n),
    parentId: parent,
    status,
    mergedIntoId: null,
    slug: `c${n}`,
    position: n,
    names: status === 'active' ? [{ locale: main, name: `Category ${n}` }] : [],
  });
  // 1 is top-level, 2 under 1, 3 under 2; 4 is top-level; 5 is archived.
  const treeReader: CategoryTreeReader = {
    nodes: () =>
      Promise.resolve([
        node(1, null),
        node(2, cat(1)),
        node(3, cat(2)),
        node(4, null),
        node(5, null, 'archived'),
      ]),
  };

  const check: AuthorisationCheck = {
    check: (_c, declaration) =>
      Promise.resolve(
        declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.every((key) => permissions.includes(key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };

  // The locales with claim terms; every locale the Market supports unless a test narrows it.
  let covered: readonly string[] | null = [...locales.supported];
  const claimLocales: ClaimTermLocales = {
    covered: () =>
      Promise.resolve(
        covered === null ? err({ code: 'claim-text.check-unavailable' } as const) : ok(covered),
      ),
  };

  // The sellers answer: nobody approved by default; a test flips it, or makes it unreadable.
  let approvedMembers: 'none' | 'some' | 'unreadable' = 'none';
  let appearAfterCommit = false;
  const memberCalls: string[] = [];
  const cultureMembers: CultureMembers = {
    hasApproved: (_c, id) => {
      memberCalls.push(id);
      if (approvedMembers === 'unreadable') {
        return Promise.resolve(err({ code: 'culture-members.unavailable' } as const));
      }
      const answer = approvedMembers === 'some' || (appearAfterCommit && memberCalls.length > 1);
      if (answer && memberCalls.length > 1) staleSaves = staleSavesOnRevert;
      return Promise.resolve(ok(answer));
    },
    demoteAll: (_c, id) => {
      demoteCalls.push(id);
      return Promise.resolve(ok(true));
    },
  };

  const build = (matcher: ClaimTextMatcher = cleanClaimTextMatcher) => {
    const gate = createUseCaseGate(markets, check);
    const write = {
      unitOfWork,
      cultures,
      policy,
      matcher,
      claimLocales,
      evaluator,
      audit,
      clock,
      cultureMembers,
    };
    const markDeps = { unitOfWork, cultures, treeReader, policy };
    return {
      create: new CultureCreate(gate, { ...write, ids }),
      edit: new CultureEdit(gate, write),
      get: new CultureGet(gate, { unitOfWork, cultures }),
      list: new CultureList(gate, { unitOfWork, cultureReader }),
      marks: new CultureCategoryMarks(gate, markDeps),
      setMark: new CultureCategoryMarkSet(gate, { ...markDeps, audit, clock }),
      clearMark: new CultureCategoryMarkClear(gate, { unitOfWork, cultures, audit }),
      seed: new SeedCultures(gate, {
        unitOfWork,
        cultures,
        cultureSeed: new CheckedInCultureSeed({
          [code]: [
            {
              code: 'first',
              displayOrder: 0,
              requiredCertificationType: type,
              badgeColour: null,
              isDefault: true,
              names: [{ locale: main, name: 'Muslim community', description: 'Seeded' }],
            },
          ],
        }),
        policy,
        evaluator,
        matcher,
        claimLocales,
        clock,
        ids,
      }),
    };
  };

  const contextOf = (population: 'admin' | 'seller'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ids.next<'Account'>(),
        sessionId: ids.next<'Session'>(),
        sellerId: population === 'seller' ? ids.next<'Seller'>() : null,
      }),
    );
  const admin = contextOf('admin');

  beforeEach(() => {
    rows.clear();
    marks.clear();
    audits = [];
    permissions = ['catalog.culture.read', 'catalog.culture.edit'];
    activeTypes = new Set([type]);
  });

  const created = async (extra: Record<string, unknown> = {}, codeName = 'first-culture') => {
    const result = await build().create.execute(admin, {
      code: codeName,
      names: { [main]: text('First') },
      ...extra,
    });
    if (!result.ok) throw new Error(result.error.code);
    return result.value.culture;
  };

  it('declares permission rules under their own names; edit is the protected key', () => {
    expect(CultureCreate.access).toEqual({
      name: 'catalog.culture-create',
      rule: { kind: 'permissions', allOf: ['catalog.culture.edit'] },
    });
    for (const useCase of [CultureEdit, CultureCategoryMarkSet, CultureCategoryMarkClear]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: ['catalog.culture.edit'] });
    }
    for (const useCase of [CultureGet, CultureList, CultureCategoryMarks]) {
      expect(useCase.access.rule).toEqual({ kind: 'permissions', allOf: ['catalog.culture.read'] });
    }
    expect(SeedCultures.access.rule).toEqual({ kind: 'system' });
  });

  it('refuses a caller without the key, and a non-admin population', async () => {
    permissions = ['catalog.culture.read'];
    const { create, list } = build();
    const names = { [main]: text('X') };
    expect(await create.execute(admin, { code: 'x', names })).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(await list.execute(admin, {})).toMatchObject({ ok: true });
    permissions = ['catalog.culture.read', 'catalog.culture.edit'];
    expect(await create.execute(contextOf('seller'), { code: 'x', names })).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
    expect(rows.size).toBe(0);
  });

  it('creates a draft culture that is not the default, and audits it', async () => {
    const culture = await created({
      names: { [main]: text('First'), [second]: { name: 'الأول' } },
      displayOrder: 3,
      badgeColour: 'accent',
      requiredCertificationType: type,
    });

    expect(culture).toMatchObject({
      code: 'first-culture',
      status: 'draft',
      isDefault: false,
      displayOrder: 3,
      badgeColour: 'accent',
      requiredCertificationType: type,
      publishedLocales: [main],
      version: 1,
    });
    expect(culture.names[second]).toEqual({ name: 'الأول', description: null });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'catalog.culture.created',
      after: { status: 'draft', requiresCertification: true },
    });
    expect(JSON.stringify(audits[0])).not.toContain('First');
  });

  it('refuses a missing code or default-locale text, an unknown key and a bad value together', async () => {
    const { create } = build();

    expect(await create.execute(admin, { names: { [second]: { name: 'x' } } })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [
          { path: 'code', code: 'format' },
          { path: `names.${main}.name`, code: 'required' },
        ],
      },
    });
    expect(await create.execute(admin, { code: 'a', names: { [main]: { name: 'A' } } })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: `names.${main}.description`, code: 'required' }],
      },
    });
    expect(
      await create.execute(admin, { code: 'a', names: { [main]: text('A') }, extra: 1 } as never),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'extra', code: 'unknown' }] },
    });
    expect(
      await create.execute(admin, {
        code: 'Bad Code',
        names: { [main]: text('A') },
        badgeColour: '#fff',
        displayOrder: -1,
      }),
    ).toMatchObject({
      error: {
        fields: [
          { path: 'code', code: 'format' },
          { path: 'displayOrder', code: 'range' },
          { path: 'badgeColour', code: 'format' },
        ],
      },
    });
  });

  it('refuses a taken code', async () => {
    await created();
    const again = await build().create.execute(admin, {
      code: 'first-culture',
      names: { [main]: text('Other') },
    });
    expect(again).toEqual({ ok: false, error: { code: 'culture.code-taken' } });
  });

  it('runs the code through the claim-term matcher, so a code like halal-certified is refused', async () => {
    const hit = { typeCode: type, span: { fromToken: 0, toToken: 0 } };
    const matcher: ClaimTextMatcher = {
      match: (_c, texts) =>
        Promise.resolve(ok(texts.map((t) => (/halal/i.test(t.text) ? [hit] : [])))),
    };

    const refused = await build(matcher).create.execute(admin, {
      code: 'halal-certified',
      names: { [main]: text('Folk') },
    });
    const allowed = await build(matcher).create.execute(admin, {
      code: 'folk',
      names: { [main]: text('Folk') },
    });

    expect(refused).toEqual({
      ok: false,
      error: { code: 'culture.claim-word', fields: [{ path: 'code', code: 'claim-word' }] },
    });
    expect(allowed.ok).toBe(true);
    expect(rows.size).toBe(1);
  });

  it('answers conflict.stale when another admin took the default at the same moment', async () => {
    const culture = await created();
    const racing: CultureRepository = {
      ...cultures,
      save: () => Promise.resolve('conflict.stale'),
    };
    const edit = new CultureEdit(createUseCaseGate(markets, check), {
      unitOfWork,
      cultures: racing,
      policy,
      matcher: cleanClaimTextMatcher,
      claimLocales,
      evaluator,
      audit,
      clock,
      cultureMembers,
    });

    expect(
      await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        status: 'active',
        isDefault: true,
      }),
    ).toEqual({ ok: false, error: { code: 'conflict.stale' } });
  });

  it('refuses text that asserts a certification and fails closed when the matcher is down', async () => {
    const hit = { typeCode: type, span: { fromToken: 0, toToken: 0 } };
    const matcher: ClaimTextMatcher = {
      match: (_c, texts) =>
        Promise.resolve(ok(texts.map((t) => (t.text.includes('Certified') ? [hit] : [])))),
    };

    const refused = await build(matcher).create.execute(admin, {
      code: 'a',
      names: { [main]: { name: 'Certified folk', description: 'Plain text' } },
    });
    const down = await build(unavailableClaimTextMatcher).create.execute(admin, {
      code: 'b',
      names: { [main]: text('Folk') },
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'culture.claim-word',
        fields: [{ path: `names.${main}.name`, code: 'claim-word' }],
      },
    });
    expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(rows.size).toBe(0);
  });

  it('refuses a name in a locale with no claim terms, and fails closed when the locales cannot be read', async () => {
    const { create, edit } = build();
    covered = [main];
    const refused = await create.execute(admin, {
      code: 'uncovered',
      names: { [main]: text('Folk'), [second]: text('Folk two') },
    });
    covered = null;
    const down = await create.execute(admin, { code: 'down', names: { [main]: text('Down') } });
    covered = [...locales.supported];
    const made = await create.execute(admin, { code: 'ok', names: { [main]: text('Fine') } });
    const id = made.ok ? made.value.culture.id : '';
    covered = [main];
    const edited = await edit.execute(admin, {
      cultureId: id,
      version: 1,
      names: { [main]: text('Fine'), [second]: text('Second') },
    });

    expect(refused).toEqual({
      ok: false,
      error: {
        code: 'culture.locale-uncheckable',
        fields: [
          { path: `names.${second}.name`, code: 'locale-uncheckable' },
          { path: `names.${second}.description`, code: 'locale-uncheckable' },
        ],
      },
    });
    expect(down).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    expect(edited).toMatchObject({ ok: false, error: { code: 'culture.locale-uncheckable' } });
    covered = [...locales.supported];
  });

  it('accepts only an active certification type of the Market, and fails closed when it cannot ask', async () => {
    const { create } = build();
    const base = { code: 'typed', names: { [main]: text('Typed') } };

    expect(await create.execute(admin, { ...base, requiredCertificationType: 'vegan' })).toEqual({
      ok: false,
      error: {
        code: 'validation.failed',
        fields: [{ path: 'requiredCertificationType', code: 'unknown' }],
      },
    });
    activeTypes = null;
    expect(await create.execute(admin, { ...base, requiredCertificationType: type })).toEqual({
      ok: false,
      error: { code: 'access.unavailable' },
    });
    expect(rows.size).toBe(0);
  });

  it('edits order, badge and names, keeps the code, and audits which parts changed', async () => {
    const culture = await created({ requiredCertificationType: type });
    audits = [];

    const result = await build().edit.execute(admin, {
      cultureId: culture.id,
      version: 1,
      displayOrder: 7,
      badgeColour: 'brand',
      requiredCertificationType: null,
      names: { [main]: text('Renamed') },
    });

    expect(result).toMatchObject({
      ok: true,
      value: {
        culture: {
          code: 'first-culture',
          displayOrder: 7,
          badgeColour: 'brand',
          requiredCertificationType: null,
          version: 2,
          names: { [main]: { name: 'Renamed' } },
        },
      },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: 'catalog.culture.edited',
      before: { requiresCertification: true },
      after: {
        orderChanged: true,
        badgeChanged: true,
        namesChanged: true,
        requiredCertificationTypeChanged: true,
        requiresCertification: false,
      },
    });
  });

  it('leaves a field out unchanged and refuses a stale version, an unknown id and a closed-body breach', async () => {
    const culture = await created({ badgeColour: 'accent' });
    const { edit } = build();

    const kept = await edit.execute(admin, { cultureId: culture.id, version: 1, displayOrder: 2 });
    expect(kept).toMatchObject({ ok: true, value: { culture: { badgeColour: 'accent' } } });
    expect(
      await edit.execute(admin, { cultureId: culture.id, version: 1, displayOrder: 3 }),
    ).toEqual({
      ok: false,
      error: { code: 'conflict.stale' },
    });
    expect(await edit.execute(admin, { cultureId: ids.next<'Culture'>(), version: 1 })).toEqual({
      ok: false,
      error: { code: 'culture.not-found' },
    });
    expect(
      await edit.execute(admin, { cultureId: culture.id, version: 2, code: 'new-code' } as never),
    ).toEqual({
      ok: false,
      error: { code: 'validation.failed', fields: [{ path: 'code', code: 'unknown' }] },
    });
  });

  it('moves a culture through its statuses and never back to draft', async () => {
    const culture = await created();
    const { edit } = build();

    expect(
      await edit.execute(admin, { cultureId: culture.id, version: 1, status: 'inactive' }),
    ).toEqual({ ok: false, error: { code: 'culture.status-transition' } });
    await edit.execute(admin, { cultureId: culture.id, version: 1, status: 'active' });
    await edit.execute(admin, { cultureId: culture.id, version: 2, status: 'inactive' });
    expect(
      await edit.execute(admin, { cultureId: culture.id, version: 3, status: 'draft' }),
    ).toEqual({ ok: false, error: { code: 'culture.status-transition' } });
  });

  it('makes one culture the default at a time and never lets the default go inactive', async () => {
    const first = await created({}, 'first-culture');
    const second = await created({}, 'second-culture');
    const { edit } = build();

    expect(await edit.execute(admin, { cultureId: first.id, version: 1, isDefault: true })).toEqual(
      { ok: false, error: { code: 'culture.default-must-be-active' } },
    );

    await edit.execute(admin, {
      cultureId: first.id,
      version: 1,
      status: 'active',
      isDefault: true,
    });
    expect(
      await edit.execute(admin, { cultureId: first.id, version: 2, status: 'inactive' }),
    ).toEqual({ ok: false, error: { code: 'culture.default-must-stay-active' } });
    expect(
      await edit.execute(admin, { cultureId: first.id, version: 2, isDefault: false }),
    ).toEqual({ ok: false, error: { code: 'culture.default-required' } });

    await edit.execute(admin, {
      cultureId: second.id,
      version: 1,
      status: 'active',
      isDefault: true,
    });
    expect([...rows.values()].filter((r) => r.isDefault).map((r) => r.code)).toEqual([
      'second-culture',
    ]);
    expect(
      await edit.execute(admin, { cultureId: first.id, version: 2, status: 'inactive' }),
    ).toMatchObject({ ok: false, error: { code: 'conflict.stale' } });
  });

  it('claim-checks only the texts an edit changes, so an unchanged text stays editable', async () => {
    const hit = { typeCode: type, span: { fromToken: 0, toToken: 0 } };
    const matcher: ClaimTextMatcher = {
      match: (_c, texts) =>
        Promise.resolve(ok(texts.map((t) => (t.text.includes('Halal') ? [hit] : [])))),
    };
    // A text stored before the matcher knew a word stays editable while it is left alone.
    const legacy = await created({ names: { [main]: text('Halal community') } }, 'legacy');
    const stored = rows.get(legacy.id)!;
    const { edit } = build(matcher);
    const same = { [main]: text('Halal community') };

    const untouched = await edit.execute(admin, {
      cultureId: stored.id,
      version: 1,
      names: same,
      displayOrder: 4,
    });
    const changed = await edit.execute(admin, {
      cultureId: stored.id,
      version: 2,
      names: { [main]: { name: 'Halal community', description: 'Halal and more' } },
    });

    expect(untouched).toMatchObject({ ok: true, value: { culture: { displayOrder: 4 } } });
    expect(changed).toMatchObject({
      ok: false,
      error: { code: 'culture.claim-word', fields: [{ path: `names.${main}.description` }] },
    });
  });

  it('checks a new required type but not one that is unchanged', async () => {
    const culture = await created({ requiredCertificationType: type });
    const { edit } = build();
    activeTypes = new Set();

    const same = await edit.execute(admin, {
      cultureId: culture.id,
      version: 1,
      requiredCertificationType: type,
      displayOrder: 1,
    });
    const other = await edit.execute(admin, {
      cultureId: culture.id,
      version: 2,
      requiredCertificationType: 'vegan',
    });

    expect(same.ok).toBe(true);
    expect(other).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
  });

  describe('required type lock (security review M1)', () => {
    beforeEach(() => {
      approvedMembers = 'none';
      appearAfterCommit = false;
      staleSaves = 0;
      staleSavesOnRevert = 0;
      demoteCalls.length = 0;
      memberCalls.length = 0;
    });

    it('retries the revert on a stale write and audits it', async () => {
      const culture = await created();
      const { edit, get } = build();
      appearAfterCommit = true;
      staleSavesOnRevert = 2;
      memberCalls.length = 0;
      audits = [];

      const result = await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
      });

      expect(result).toEqual({ ok: false, error: { code: 'culture.required-type-locked' } });
      expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
        value: { culture: { requiredCertificationType: null } },
      });
      expect(demoteCalls).toEqual([]);
      // The edit and the revert are both audited.
      expect(audits).toHaveLength(2);
    });

    it('takes every approval back when the revert keeps failing', async () => {
      const culture = await created();
      const { edit, get } = build();
      appearAfterCommit = true;
      staleSavesOnRevert = 3;
      memberCalls.length = 0;

      const result = await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
      });

      expect(result).toEqual({ ok: false, error: { code: 'access.unavailable' } });
      expect(demoteCalls).toEqual([culture.id]);
      expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
        value: { culture: { requiredCertificationType: type } },
      });
    });

    it('writes nothing when the change is locked', async () => {
      const culture = await created();
      const { edit, get } = build();
      approvedMembers = 'some';
      audits = [];

      await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
        displayOrder: 9,
      });

      expect(audits).toEqual([]);
      expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
        value: { culture: { version: 1, displayOrder: culture.displayOrder } },
      });
    });

    it('refuses a changed required type while a seller is approved', async () => {
      const culture = await created();
      const { edit, get } = build();
      approvedMembers = 'some';
      memberCalls.length = 0;

      const result = await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
      });

      expect(result).toEqual({ ok: false, error: { code: 'culture.required-type-locked' } });
      expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
        value: { culture: { requiredCertificationType: null } },
      });
    });

    it('fails closed when sellers cannot answer', async () => {
      const culture = await created();
      const { edit } = build();
      approvedMembers = 'unreadable';
      memberCalls.length = 0;

      expect(
        await edit.execute(admin, {
          cultureId: culture.id,
          version: 1,
          requiredCertificationType: type,
        }),
      ).toEqual({ ok: false, error: { code: 'access.unavailable' } });
    });

    it('puts the old type back when an approval appears during the edit', async () => {
      const culture = await created();
      const { edit, get } = build();
      appearAfterCommit = true;
      memberCalls.length = 0;

      const result = await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
      });

      expect(result).toEqual({ ok: false, error: { code: 'culture.required-type-locked' } });
      expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
        value: { culture: { requiredCertificationType: null } },
      });
    });

    it('does not ask sellers when the type is unchanged', async () => {
      const culture = await created({ requiredCertificationType: type });
      const { edit } = build();
      approvedMembers = 'some';
      memberCalls.length = 0;

      const result = await edit.execute(admin, {
        cultureId: culture.id,
        version: 1,
        requiredCertificationType: type,
        displayOrder: 3,
      });

      expect(result.ok).toBe(true);
      expect(memberCalls).toEqual([]);
    });
  });

  it('lists and reads cultures', async () => {
    const culture = await created();
    const { list, get } = build();

    expect(await list.execute(admin, { status: 'draft' })).toMatchObject({
      ok: true,
      value: { items: [{ id: culture.id }] },
    });
    expect(await list.execute(admin, { status: 'bogus' })).toMatchObject({ ok: false });
    expect(await get.execute(admin, { cultureId: culture.id })).toMatchObject({
      ok: true,
      value: { culture: { code: 'first-culture' } },
    });
    expect(await get.execute(admin, { cultureId: 'nope' })).toEqual({
      ok: false,
      error: { code: 'culture.not-found' },
    });
  });

  describe('category marks', () => {
    it('lists every live category with the default visible and required', async () => {
      const culture = await created();

      const result = await build().marks.execute(admin, { cultureId: culture.id });

      expect(result.ok && result.value.items.map((i) => i.categoryId)).toEqual([
        cat(1),
        cat(2),
        cat(3),
        cat(4),
      ]);
      expect(result.ok && result.value.items[0]).toMatchObject({
        own: null,
        effective: {
          visible: true,
          certificationMark: 'required',
          markSource: { kind: 'default' },
        },
      });
    });

    it('sets a row on a branch, which its descendants inherit, and audits it', async () => {
      const culture = await created();
      const { setMark, marks: list } = build();
      audits = [];

      const set = await setMark.execute(admin, {
        cultureId: culture.id,
        categoryId: cat(1),
        visible: false,
        certificationMark: 'neutral',
      });
      const items = await list.execute(admin, { cultureId: culture.id });

      expect(set).toMatchObject({
        ok: true,
        value: {
          mark: { categoryId: cat(1), own: { visible: false, certificationMark: 'neutral' } },
        },
      });
      const three = items.ok ? items.value.items.find((i) => i.categoryId === cat(3)) : undefined;
      expect(three).toMatchObject({
        own: null,
        effective: {
          visible: false,
          certificationMark: 'neutral',
          visibleSource: { kind: 'inherited', fromCategoryId: cat(1) },
        },
      });
      const four = items.ok ? items.value.items.find((i) => i.categoryId === cat(4)) : undefined;
      expect(four?.effective.visible).toBe(true);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'catalog.culture.category-mark-changed',
        before: { hadRow: false, certificationMark: 'inherit' },
        after: { hasRow: true, visible: false, certificationMark: 'neutral' },
      });
    });

    it('lets a child override its parent and clearing returns it to inheritance', async () => {
      const culture = await created();
      const { setMark, clearMark, marks: list } = build();
      await setMark.execute(admin, {
        cultureId: culture.id,
        categoryId: cat(1),
        certificationMark: 'neutral',
      });
      await setMark.execute(admin, {
        cultureId: culture.id,
        categoryId: cat(2),
        certificationMark: 'required',
      });

      const read = async (n: number) => {
        const items = await list.execute(admin, { cultureId: culture.id });
        return items.ok ? items.value.items.find((i) => i.categoryId === cat(n))!.effective : null;
      };
      expect((await read(3))?.certificationMark).toBe('required');
      expect(await clearMark.execute(admin, { cultureId: culture.id, categoryId: cat(2) })).toEqual(
        {
          ok: true,
          value: { cleared: true },
        },
      );
      expect((await read(3))?.certificationMark).toBe('neutral');
      expect(await clearMark.execute(admin, { cultureId: culture.id, categoryId: cat(2) })).toEqual(
        {
          ok: false,
          error: { code: 'culture-category.not-found' },
        },
      );
    });

    it('refuses a category that is archived or unknown, a bad mark and an unknown culture', async () => {
      const culture = await created();
      const { setMark } = build();

      expect(await setMark.execute(admin, { cultureId: culture.id, categoryId: cat(5) })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'categoryId', code: 'unknown' }] },
      });
      expect(
        await setMark.execute(admin, {
          cultureId: culture.id,
          categoryId: cat(1),
          certificationMark: 'REQUIRED',
        }),
      ).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(
        await setMark.execute(admin, { cultureId: ids.next<'Culture'>(), categoryId: cat(1) }),
      ).toEqual({ ok: false, error: { code: 'culture.not-found' } });
      expect(marks.size).toBe(0);
    });

    it('needs the edit key to set and only the read key to list', async () => {
      const culture = await created();
      permissions = ['catalog.culture.read'];
      const { setMark, marks: list } = build();

      expect(await list.execute(admin, { cultureId: culture.id })).toMatchObject({ ok: true });
      expect(
        await setMark.execute(admin, { cultureId: culture.id, categoryId: cat(1) }),
      ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('seed', () => {
    it('creates the first culture active and default once, and never overwrites it', async () => {
      const { seed } = build();

      expect(await seed.execute(testCallContext(market, 'system'), {})).toEqual({
        ok: true,
        value: { created: 1 },
      });
      const stored = [...rows.values()][0]!;
      expect(stored).toMatchObject({
        code: 'first',
        status: 'active',
        isDefault: true,
        requiredCertificationType: type,
        createdBy: null,
      });
      rows.set(stored.id, { ...stored, displayOrder: 9 });
      expect(await seed.execute(testCallContext(market, 'system'), {})).toEqual({
        ok: true,
        value: { created: 0 },
      });
      expect([...rows.values()][0]!.displayOrder).toBe(9);
    });

    it('claim-checks the seeded code and text as the system actor and fails closed', async () => {
      const hit = { typeCode: type, span: { fromToken: 0, toToken: 0 } };
      const matcher: ClaimTextMatcher = {
        match: (_c, texts) =>
          Promise.resolve(ok(texts.map((t) => (t.text.includes('Muslim') ? [hit] : [])))),
      };

      expect(await build(matcher).seed.execute(testCallContext(market, 'system'), {})).toEqual({
        ok: false,
        error: { code: 'culture.seed-claim-text-refused', seedCode: 'first' },
      });
      expect(
        await build(unavailableClaimTextMatcher).seed.execute(
          testCallContext(market, 'system'),
          {},
        ),
      ).toEqual({
        ok: false,
        error: { code: 'culture.seed-claim-text-unavailable', seedCode: 'first' },
      });
      expect(rows.size).toBe(0);
    });

    it('does not take the default mark when the Market already has one', async () => {
      await created();
      const first = [...rows.values()][0]!;
      rows.set(first.id, { ...first, status: 'active', isDefault: true });

      await build().seed.execute(testCallContext(market, 'system'), {});

      expect([...rows.values()].filter((r) => r.isDefault).map((r) => r.code)).toEqual([
        'first-culture',
      ]);
    });

    it('is refused while the required type does not exist yet, and for a non-system actor', async () => {
      activeTypes = new Set();
      const { seed } = build();

      expect(await seed.execute(testCallContext(market, 'system'), {})).toEqual({
        ok: false,
        error: { code: 'culture.seed-type-unavailable', seedCode: 'first' },
      });
      expect(rows.size).toBe(0);
      expect(await seed.execute(admin, {})).toMatchObject({ ok: false });
    });
  });
});

describe('the checked-in culture seed', () => {
  it('has a default culture for AU that requires halal, and one for ZZ that requires nothing', () => {
    const seed = new CheckedInCultureSeed();
    const au = seed.cultures(testMarketContext('AU', 'default'));
    const zz = seed.cultures(testMarketContext('ZZ', 'default'));

    expect(au).toHaveLength(1);
    expect(au[0]).toMatchObject({
      code: 'muslim',
      requiredCertificationType: 'halal',
      isDefault: true,
    });
    expect(au[0]!.names[0]).toMatchObject({ locale: 'en-AU', name: 'Muslim community' });
    expect(zz).toHaveLength(1);
    expect(zz[0]).toMatchObject({ requiredCertificationType: null, isDefault: true });
  });

  it('refuses two defaults and a repeated code', () => {
    const one = {
      code: 'a',
      displayOrder: 0,
      requiredCertificationType: null,
      badgeColour: null,
      isDefault: true,
      names: [],
    };
    expect(() => new CheckedInCultureSeed({ AU: [one, { ...one, code: 'b' }] })).toThrow();
    expect(() => new CheckedInCultureSeed({ AU: [one, { ...one, isDefault: false }] })).toThrow();
  });
});
