import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAttributeDefinitionStore as MemoryStore } from '../../../../../test/support/catalog-attribute-editor-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher, ClaimTextToMatch } from '../ports/claim-text-matcher';
import { AttributeDefinitionCreate } from './attribute-definition-create.use-case';
import { AttributeDefinitionDiscard } from './attribute-definition-discard.use-case';
import { AttributeDefinitionEdit } from './attribute-definition-edit.use-case';
import { AttributeDefinitionPublish } from './attribute-definition-publish.use-case';

// The attribute editor's use cases in memory (attributes plan, package A2), on both Market
// fixtures: the protected key, the admin population and the acting-as refusal; the closed input;
// the claim-word check of every customer-visible text in every locale, fail closed for a locale
// the vocabulary cannot read and for an unreadable vocabulary; the version check; the domain
// rules (values never removed, published flags); and one audit row per write. The SQL is in
// test/db/catalog-attribute-editor.db-spec.ts, the routes in test/catalog-attribute-editor.e2e.spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-02T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1';

describe.each(['AU', 'ZZ'] as const)('attribute editor use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const locales = policy.locales(market);
  const english = locales.default;
  const second = locales.supported.find((locale) => locale !== english) ?? null;

  const context = (population: 'admin' | 'seller' = 'admin'): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN as never,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId:
          population === 'seller' ? ('01990000-0000-7000-8000-0000000000a3' as never) : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context();
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let store: MemoryStore;
  let audits: AuditEntry[];
  let allow: boolean;
  let covered: Result<readonly string[], { code: 'claim-text.check-unavailable' }>;
  let matcherDown: boolean;
  let claimWords: RegExp;
  let matched: ClaimTextToMatch[];
  let unitOpen: boolean;
  let claimInsideUnit: boolean;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          declaration.rule.allOf.includes(CATALOG_ATTRIBUTE_EDIT.key)
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      unitOpen = true;
      try {
        return await work();
      } finally {
        unitOpen = false;
      }
    },
  } as unknown as UnitOfWork;
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) => {
      if (unitOpen) claimInsideUnit = true;
      matched.push(...texts);
      if (matcherDown) return Promise.resolve(err({ code: 'claim-text.check-unavailable' }));
      return Promise.resolve(
        ok(
          texts.map((t) =>
            claimWords.test(t.text)
              ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
              : [],
          ),
        ),
      );
    },
  };
  const claimLocales: ClaimTermLocales = {
    covered: () => {
      if (unitOpen) claimInsideUnit = true;
      return Promise.resolve(covered);
    },
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };

  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const deps = {
      unitOfWork,
      attributeStore: store,
      policy,
      matcher,
      claimLocales,
      audit,
      clock,
      ids,
    };
    return {
      create: new AttributeDefinitionCreate(gate, deps),
      edit: new AttributeDefinitionEdit(gate, deps),
      publish: new AttributeDefinitionPublish(gate, deps),
      discard: new AttributeDefinitionDiscard(gate, deps),
    };
  };

  beforeEach(() => {
    store = new MemoryStore();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    allow = true;
    covered = ok([...locales.supported]);
    matcherDown = false;
    claimWords = /halal/i;
    matched = [];
    unitOpen = false;
    claimInsideUnit = false;
  });

  const selectBody = (overrides: Record<string, unknown> = {}) => ({
    dataType: 'select',
    names: { [english]: 'Pack size' },
    options: [{ labels: { [english]: '500 g' } }, { code: 'kg1', labels: { [english]: '1 kg' } }],
    ...overrides,
  });

  async function createdSelect(overrides: Record<string, unknown> = {}) {
    const answer = await build().create.execute(context(), selectBody(overrides));
    if (!answer.ok) throw new Error(`create failed: ${answer.error.code}`);
    return answer.value.attribute;
  }

  describe('create', () => {
    it('adds a draft with a code from the default name, authored by the admin, and one audit row', async () => {
      const answer = await build().create.execute(context(), selectBody());
      expect(answer).toEqual(
        ok({
          attribute: <unknown>expect.objectContaining({
            code: 'pack-size',
            status: 'draft',
            version: 1,
            revisionNo: 1,
          }),
        }),
      );
      const stored = [...store.rows.values()][0]!.state;
      expect(stored.marketId).toBe(market.marketId);
      expect(stored.createdByKind).toBe('admin');
      expect(stored.options.map((o) => [o.code, o.position, o.active])).toEqual([
        ['v-500-g', 0, true],
        ['kg1', 1, true],
      ]);
      expect(store.authors).toEqual([{ revisionId: stored.revisionId, author: ADMIN }]);
      expect(audits.map((a) => [a.action, a.targetId])).toEqual([
        ['catalog.attribute-definition.created', stored.id],
      ]);
      expect(claimInsideUnit).toBe(false);
    });

    it('checks every name, help text and value label, but not the internal note', async () => {
      await build().create.execute(
        context(),
        selectBody({ helpText: { [english]: 'Net weight' }, internalNote: 'halal note' }),
      );
      expect(matched.map((t) => t.text).sort()).toEqual([
        '1 kg',
        '500 g',
        'Net weight',
        'Pack size',
      ]);
    });

    it('refuses a claim word in any text, naming the fields and never the words', async () => {
      const answer = await build().create.execute(
        context(),
        selectBody({
          names: { [english]: 'Halal size' },
          options: [{ code: 'a', labels: { [english]: 'certified halal' } }],
        }),
      );
      expect(answer).toEqual(
        err({
          code: 'attribute.claim-word',
          fields: [
            { path: `names.${english}`, code: 'claim-word' },
            { path: `options[0].labels.${english}`, code: 'claim-word' },
          ],
        }),
      );
      expect(store.rows.size).toBe(0);
      expect(audits).toEqual([]);
    });

    it('refuses a text in a locale the claim vocabulary cannot read (fail closed)', async () => {
      covered = ok(second === null ? [] : [english]);
      const names =
        second === null
          ? { [english]: 'Pack size' }
          : { [english]: 'Pack size', [second]: 'Größe' };
      const answer = await build().create.execute(context(), selectBody({ names }));
      expect(answer).toEqual(
        err({
          code: 'attribute.locale-uncheckable',
          fields: <unknown>(
            expect.arrayContaining([
              { path: `names.${second ?? english}`, code: 'locale-uncheckable' },
            ])
          ),
        }),
      );
      if (!answer.ok && 'fields' in answer.error && second !== null) {
        // Only the texts in the locale the vocabulary cannot read.
        expect(answer.error.fields).toEqual([
          { path: `names.${second}`, code: 'locale-uncheckable' },
        ]);
      }
      expect(matched).toEqual([]);
      expect(store.rows.size).toBe(0);
    });

    it('refuses the save when the vocabulary or the matcher cannot answer', async () => {
      covered = err({ code: 'claim-text.check-unavailable' });
      expect(await build().create.execute(context(), selectBody())).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      covered = ok([...locales.supported]);
      matcherDown = true;
      expect(await build().create.execute(context(), selectBody())).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      expect(store.rows.size).toBe(0);
    });

    it('needs the default-locale name', async () => {
      const names = second === null ? {} : { [second]: 'Pack size' };
      expect(await build().create.execute(context(), selectBody({ names }))).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: `names.${english}`, code: 'required' }],
        }),
      );
    });

    it('refuses an unknown key, an unknown type and a locale the Market does not offer', async () => {
      const { create } = build();
      expect(await create.execute(context(), selectBody({ colour: 'red' }))).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'colour', code: 'unknown' }] }),
      );
      expect(await create.execute(context(), selectBody({ dataType: 'json' }))).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'dataType', code: 'unknown' }] }),
      );
      expect(
        await create.execute(context(), selectBody({ names: { [english]: 'A', 'xx-XX': 'B' } })),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'names.xx-XX', code: 'unsupported' }] }),
      );
    });

    it('answers a taken code, and suffixes a derived one', async () => {
      await createdSelect();
      const second = await createdSelect();
      expect(second.code).toBe('pack-size-2');
      expect(await build().create.execute(context(), selectBody({ code: 'pack-size' }))).toEqual(
        err({ code: 'attribute.code-taken' }),
      );
      store.raceNext = true;
      expect(await build().create.execute(context(), selectBody({ code: 'fresh' }))).toEqual(
        err({ code: 'attribute.code-taken' }),
      );
    });

    it('never derives a code that a later value names explicitly', async () => {
      const created = await createdSelect({
        options: [
          { labels: { [english]: 'Red' } },
          { code: 'red', labels: { [english]: 'Crimson' } },
        ],
      });
      expect(store.rows.get(created.id)!.state.options.map((o) => o.code)).toEqual([
        'red-2',
        'red',
      ]);
    });

    it('needs a code for a name or a value label with no Latin letters or digits', async () => {
      const { create } = build();
      expect(
        await create.execute(context(), selectBody({ names: { [english]: 'パックサイズ' } })),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'code', code: 'required' }] }));
      expect(
        await create.execute(
          context(),
          selectBody({ code: 'pack', options: [{ labels: { [english]: '大きい' } }] }),
        ),
      ).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'options[0].code', code: 'required' }] }),
      );
      const named = await createdSelect({
        code: 'pack-jp',
        names: { [english]: 'パックサイズ' },
        options: [{ code: 'large', labels: { [english]: '大きい' } }],
      });
      expect(named.code).toBe('pack-jp');
    });

    it('refuses a text longer than any the domain keeps before it is checked', async () => {
      const answer = await build().create.execute(
        context(),
        selectBody({ names: { [english]: 'x'.repeat(301) } }),
      );
      expect(answer).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: `names.${english}`, code: 'too-long' }],
        }),
      );
      expect(matched).toEqual([]);
    });

    it('points an invalid text at the name or at the value whose label it is', async () => {
      const { create } = build();
      expect(
        await create.execute(context(), selectBody({ code: 'pad', names: { [english]: ' Pack' } })),
      ).toEqual(
        err({
          code: 'attribute-definition.text-invalid',
          fields: [{ path: `names.${english}`, code: 'invalid' }],
        }),
      );
      expect(
        await create.execute(
          context(),
          selectBody({ code: 'pad', options: [{ code: 'kg1', labels: { [english]: '1 kg ' } }] }),
        ),
      ).toEqual(
        err({
          code: 'attribute-definition.text-invalid',
          fields: [{ path: `options.kg1.labels.${english}`, code: 'invalid' }],
        }),
      );
    });

    it('refuses a seller, an acting-as session and an admin without the key', async () => {
      const { create } = build();
      expect(await create.execute(context('seller'), selectBody())).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await create.execute(actingAs(), selectBody())).toEqual(
        err({ code: 'access.denied' }),
      );
      allow = false;
      expect((await create.execute(context(), selectBody())).ok).toBe(false);
      expect(store.rows.size).toBe(0);
      expect(matched).toEqual([]);
    });
  });

  describe('edit', () => {
    const content = (overrides: Record<string, unknown> = {}) => ({
      names: { [english]: 'Pack size' },
      options: [
        { code: 'v-500-g', labels: { [english]: '500 g' } },
        { code: 'kg1', labels: { [english]: '1 kg' }, active: false },
        { labels: { [english]: '2 kg' } },
      ],
      helpText: { [english]: 'Net weight' },
      searchable: true,
      ...overrides,
    });

    it('saves the next revision: values added, deactivated and reordered, one audit row', async () => {
      const created = await createdSelect();
      const answer = await build().edit.execute(context(), {
        attributeId: created.id,
        version: 1,
        ...content(),
      });
      expect(answer).toEqual(
        ok({
          attribute: <unknown>(
            expect.objectContaining({ version: 2, revisionNo: 2, status: 'draft' })
          ),
        }),
      );
      const state = store.rows.get(created.id)!.state;
      expect(state.options.map((o) => [o.code, o.active, o.position])).toEqual([
        ['v-500-g', true, 0],
        ['kg1', false, 1],
        ['v-2-kg', true, 2],
      ]);
      expect(state.display).toEqual(
        expect.objectContaining({ helpText: { [english]: 'Net weight' }, searchable: true }),
      );
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.attribute-definition.created',
        'catalog.attribute-definition.revised',
      ]);
      expect(audits[1]!.after).toEqual(
        expect.objectContaining({ optionCount: 3, activeOptionCount: 2, revisionNo: 2 }),
      );
      expect(claimInsideUnit).toBe(false);
    });

    it('never removes a value', async () => {
      const created = await createdSelect();
      const answer = await build().edit.execute(context(), {
        attributeId: created.id,
        version: 1,
        ...content({ options: [{ code: 'v-500-g', labels: { [english]: '500 g' } }] }),
      });
      expect(answer).toEqual(
        err({
          code: 'attribute-definition.option-removed',
          fields: [{ path: 'options.kg1', code: 'removed' }],
        }),
      );
    });

    it('answers attribute.stale for an old version or a lost race, and not-found for another id', async () => {
      const created = await createdSelect();
      const { edit } = build();
      expect(
        await edit.execute(context(), { attributeId: created.id, version: 2, ...content() }),
      ).toEqual(err({ code: 'attribute.stale' }));
      store.raceNext = true;
      expect(
        await edit.execute(context(), { attributeId: created.id, version: 1, ...content() }),
      ).toEqual(err({ code: 'attribute.stale' }));
      expect(
        await edit.execute(context(), {
          attributeId: '01990000-0000-7000-8000-00000000ffff',
          version: 1,
          ...content(),
        }),
      ).toEqual(err({ code: 'attribute.not-found' }));
      expect(
        await edit.execute(context(), { attributeId: 'nope', version: 1, ...content() }),
      ).toEqual(err({ code: 'attribute.not-found' }));
    });

    it('once published: material may be turned on, never cleared; the variant flag is fixed', async () => {
      const created = await createdSelect();
      const { edit, publish } = build();
      expect((await publish.execute(context(), { attributeId: created.id, version: 1 })).ok).toBe(
        true,
      );
      const on = await edit.execute(context(), {
        attributeId: created.id,
        version: 2,
        ...content({ material: true }),
      });
      expect(on.ok).toBe(true);
      expect(
        await edit.execute(context(), { attributeId: created.id, version: 3, ...content() }),
      ).toEqual(err({ code: 'attribute-definition.material-relaxation-required' }));
      expect(
        await edit.execute(context(), {
          attributeId: created.id,
          version: 3,
          ...content({ material: true, isVariantOption: true }),
        }),
      ).toEqual(err({ code: 'attribute-definition.variant-locked' }));
    });

    it('keeps a published attribute usable: the default name and an active labelled value', async () => {
      const created = await createdSelect();
      const { edit, publish } = build();
      await publish.execute(context(), { attributeId: created.id, version: 1 });
      expect(
        await edit.execute(context(), {
          attributeId: created.id,
          version: 2,
          ...content({
            options: [
              { code: 'v-500-g', labels: { [english]: '500 g' }, active: false },
              { code: 'kg1', labels: { [english]: '1 kg' }, active: false },
            ],
          }),
        }),
      ).toEqual(err({ code: 'attribute-definition.active-option-required' }));
      if (second !== null) {
        expect(
          await edit.execute(context(), {
            attributeId: created.id,
            version: 2,
            ...content({ names: { [second]: 'Pack size' } }),
          }),
        ).toEqual(
          err({
            code: 'attribute-definition.default-name-required',
            fields: [{ path: `names.${english}`, code: 'required' }],
          }),
        );
      }
    });

    it('checks the labels of the values before anything is written', async () => {
      const created = await createdSelect();
      const answer = await build().edit.execute(context(), {
        attributeId: created.id,
        version: 1,
        ...content({ helpText: { [english]: 'Always halal' } }),
      });
      expect(answer).toEqual(
        err({
          code: 'attribute.claim-word',
          fields: [{ path: `helpText.${english}`, code: 'claim-word' }],
        }),
      );
      expect(store.rows.get(created.id)!.state.version).toBe(1);
    });

    it('refuses an acting-as session', async () => {
      const created = await createdSelect();
      expect(
        await build().edit.execute(actingAs(), {
          attributeId: created.id,
          version: 1,
          ...content(),
        }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('publish and discard', () => {
    it('publishes a draft once, with one audit row', async () => {
      const created = await createdSelect();
      const { publish } = build();
      expect(await publish.execute(context(), { attributeId: created.id, version: 1 })).toEqual(
        ok({ attribute: <unknown>expect.objectContaining({ status: 'active', version: 2 }) }),
      );
      expect(audits.at(-1)).toEqual(
        expect.objectContaining({
          action: 'catalog.attribute-definition.published',
          before: { status: 'draft' },
        }),
      );
      expect(await publish.execute(context(), { attributeId: created.id, version: 2 })).toEqual(
        err({ code: 'attribute-definition.not-draft' }),
      );
    });

    it('runs the claim check again on publish, outside any unit (a term added after the save)', async () => {
      const created = await createdSelect({ names: { [english]: 'Zabiha cut' } });
      claimWords = /halal|zabiha/i;
      matched = [];
      const { publish } = build();
      expect(await publish.execute(context(), { attributeId: created.id, version: 1 })).toEqual(
        err({
          code: 'attribute.claim-word',
          fields: [{ path: `names.${english}`, code: 'claim-word' }],
        }),
      );
      expect(matched.map((t) => t.text)).toEqual(['Zabiha cut', '500 g', '1 kg']);
      expect(claimInsideUnit).toBe(false);
      matcherDown = true;
      expect(await publish.execute(context(), { attributeId: created.id, version: 1 })).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      covered = err({ code: 'claim-text.check-unavailable' });
      expect(await publish.execute(context(), { attributeId: created.id, version: 1 })).toEqual(
        err({ code: 'claim-text.check-unavailable' }),
      );
      expect(store.rows.get(created.id)!.state.status).toBe('draft');
      expect(audits.map((a) => a.action)).toEqual(['catalog.attribute-definition.created']);
    });

    it('does not run the claim check for a caller who is not an editor', async () => {
      const created = await createdSelect();
      matched = [];
      expect(
        await build().publish.execute(actingAs(), { attributeId: created.id, version: 1 }),
      ).toEqual(err({ code: 'access.denied' }));
      expect(matched).toEqual([]);
    });

    it('needs an active value before a select type is published', async () => {
      const created = await createdSelect({ options: [] });
      expect(
        await build().publish.execute(context(), { attributeId: created.id, version: 1 }),
      ).toEqual(err({ code: 'attribute-definition.active-option-required' }));
    });

    it('discards a draft as archived, never a published one', async () => {
      const draft = await createdSelect();
      const { discard, publish } = build();
      expect(await discard.execute(context(), { attributeId: draft.id, version: 1 })).toEqual(
        ok({ attribute: <unknown>expect.objectContaining({ status: 'archived', version: 2 }) }),
      );
      expect(audits.at(-1)?.action).toBe('catalog.attribute-definition.discarded');
      const live = await createdSelect();
      await publish.execute(context(), { attributeId: live.id, version: 1 });
      expect(await discard.execute(context(), { attributeId: live.id, version: 2 })).toEqual(
        err({ code: 'attribute-definition.not-draft' }),
      );
    });

    it('refuses a stale version, an unknown key and an acting-as session', async () => {
      const created = await createdSelect();
      const { publish, discard } = build();
      expect(await publish.execute(context(), { attributeId: created.id, version: 5 })).toEqual(
        err({ code: 'attribute.stale' }),
      );
      expect(
        await discard.execute(context(), {
          attributeId: created.id,
          version: 1,
          force: true,
        } as never),
      ).toEqual(err({ code: 'validation.failed', fields: [{ path: 'force', code: 'unknown' }] }));
      expect(await publish.execute(actingAs(), { attributeId: created.id, version: 1 })).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(store.rows.get(created.id)!.state.status).toBe('draft');
    });
  });
});
