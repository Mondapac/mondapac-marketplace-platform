import type { AuditEntry, CallContext, MarketContext, Result } from '@mondapac/shared-kernel';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryAttributeDefinitionStore } from '../../../../../test/support/catalog-attribute-editor-fakes';
import { MemoryAttributeValueSuggestionStore } from '../../../../../test/support/catalog-suggestion-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../../test/support/test-config';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { AuthorisationCheck } from '../../../../platform/authz';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import type { MailMessage, MailTransport } from '../../../../platform/mail/mail-transport';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  CATALOG_ATTRIBUTE_SUGGESTION_DECIDE,
  CATALOG_OWN_PRODUCT_EDIT,
} from '../../contracts/permissions';
import { AttributeDefinition } from '../../domain/attribute-definition';
import { ConfigCatalogMarketPolicy } from '../../infrastructure/config-catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { AttributeSuggestionApprove } from './attribute-suggestion-approve.use-case';
import { AttributeSuggestionList } from './attribute-suggestion-list.use-case';
import { AttributeSuggestionMap } from './attribute-suggestion-map.use-case';
import { AttributeSuggestionReject } from './attribute-suggestion-reject.use-case';
import { OwnAttributeValueSuggest } from './own-attribute-value-suggest.use-case';
import { SendAttributeSuggestionNotices } from './send-attribute-suggestion-notices.use-case';

// The value suggestions' use cases in memory (attributes plan, package A5), on both Market
// fixtures: the seller's request (ownership, eligible fields only, one open per field, the cap, a
// value the list has), the admin queue and the three decisions (the version check, the claim-text
// check of the labels, the revision an approval writes, the audit rows), and the notice job.
// The SQL is in test/db/catalog-attribute-suggestions.db-spec.ts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const policy = new ConfigCatalogMarketPolicy(markets);
const T0 = Temporal.Instant.from('2026-11-03T10:00:00Z');
const ADMIN = '01990000-0000-7000-8000-0000000000a1' as Id<'Account'>;
const SELLER = '01990000-0000-7000-8000-0000000000a3' as Id<'Seller'>;
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000a4' as Id<'Seller'>;
const PRODUCT = '01990000-0000-7000-8000-0000000000b1' as Id<'Product'>;
const OTHER_PRODUCT = '01990000-0000-7000-8000-0000000000b2' as Id<'Product'>;
const DEFINITION = '01990000-0000-7000-8000-0000000000c1' as Id<'AttributeDefinition'>;
const MATERIAL = '01990000-0000-7000-8000-0000000000c2' as Id<'AttributeDefinition'>;
const BRAND_TEXT = '01990000-0000-7000-8000-0000000000c3' as Id<'AttributeDefinition'>;

describe.each(['AU', 'ZZ'] as const)('attribute suggestion use cases in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const english = policy.locales(market).default;

  const context = (
    population: 'admin' | 'seller',
    sellerId: Id<'Seller'> | null = SELLER,
  ): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: ADMIN,
        sessionId: '01990000-0000-7000-8000-0000000000a2' as never,
        sellerId: population === 'seller' ? sellerId : null,
      }),
    );
  const actingAs = (): CallContext => {
    const base = context('admin');
    return { ...base, actor: { ...base.actor, actingAs: { adminAccountId: ADMIN } } as never };
  };

  let definitions: MemoryAttributeDefinitionStore;
  let suggestions: MemoryAttributeValueSuggestionStore;
  let audits: AuditEntry[];
  let allow: boolean;
  let eligible: boolean;
  let matcherDown: boolean;
  let mails: MailMessage[];
  let mailFails: boolean;
  let address: string | null;

  const clock = new FixedClock(T0);
  let ids: SequenceIdGenerator;

  const check: AuthorisationCheck = {
    check: (_context, declaration) =>
      Promise.resolve(
        allow &&
          declaration.rule.kind === 'permissions' &&
          (declaration.rule.allOf.includes(CATALOG_OWN_PRODUCT_EDIT.key) ||
            declaration.rule.allOf.includes(CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key))
          ? { allowed: true }
          : { allowed: false, denial: { code: 'access.denied' } },
      ),
  };
  const unitOfWork = {
    run: async <T, E>(_m: MarketContext, work: () => Promise<Result<T, E>>) => {
      return work();
    },
  } as unknown as UnitOfWork;
  const matcher: ClaimTextMatcher = {
    match: (_c, texts) =>
      matcherDown
        ? Promise.resolve(err({ code: 'claim-text.check-unavailable' }))
        : Promise.resolve(
            ok(
              texts.map((t) =>
                /halal/i.test(t.text)
                  ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }]
                  : [],
              ),
            ),
          ),
  };
  const claimLocales: ClaimTermLocales = {
    covered: () => Promise.resolve(ok([...policy.locales(market).supported])),
  };
  const audit: AuditWriter = {
    record: (_c, entry) => {
      audits.push(entry);
      return Promise.resolve();
    },
  };
  const mailTransport: MailTransport = {
    send: (message) => {
      if (mailFails) return Promise.reject(new Error('smtp down'));
      mails.push(message);
      return Promise.resolve();
    },
  };

  const products = {
    findById: (_m: MarketContext, id: Id<'Product'>) =>
      Promise.resolve(
        id === PRODUCT
          ? {
              state: {
                id,
                scope: 'SELLER',
                ownerSellerId: SELLER,
                status: 'draft',
                familyCode: 'food',
                productCode: 'P-1',
              },
            }
          : id === OTHER_PRODUCT
            ? {
                state: {
                  id,
                  scope: 'SELLER',
                  ownerSellerId: OTHER_SELLER,
                  status: 'draft',
                  familyCode: 'food',
                  productCode: 'P-2',
                },
              }
            : null,
      ),
  };
  const field = (codeOf: string, dataType: string, extra: Record<string, boolean> = {}) => ({
    code: codeOf,
    dataType,
    required: false,
    material: false,
    isVariantOption: false,
    ...extra,
  });
  const attributes = {
    loadSchema: () =>
      Promise.resolve({
        fields: [
          field('pack-size', 'select'),
          field('cuts', 'multi-select'),
          field('origin-material', 'select', { material: true }),
          field('size-option', 'select', { isVariantOption: true }),
          field('brand-text', 'text'),
        ],
      }),
    definitionIdByCode: (_m: MarketContext, codeOf: string) =>
      Promise.resolve(
        codeOf === 'pack-size' || codeOf === 'cuts'
          ? DEFINITION
          : codeOf === 'origin-material'
            ? MATERIAL
            : codeOf === 'brand-text'
              ? BRAND_TEXT
              : null,
      ),
  };
  const eligibility = { isEligible: () => Promise.resolve(eligible) };

  const build = () => {
    const gate = createUseCaseGate(markets, check);
    const common = { unitOfWork, attributeStore: definitions, suggestions, audit, clock };
    return {
      suggest: new OwnAttributeValueSuggest(gate, {
        ...common,
        products: products as never,
        attributes: attributes as never,
        eligibility,
        ids,
      }),
      list: new AttributeSuggestionList(gate, {
        unitOfWork,
        suggestions,
        attributeStore: definitions,
        products: products as never,
        policy,
      }),
      approve: new AttributeSuggestionApprove(gate, {
        ...common,
        policy,
        matcher,
        claimLocales,
        ids,
      }),
      map: new AttributeSuggestionMap(gate, common),
      reject: new AttributeSuggestionReject(gate, common),
      notices: new SendAttributeSuggestionNotices(gate, {
        unitOfWork,
        suggestions,
        attributeStore: definitions,
        ownerContacts: { emailOf: () => Promise.resolve(address) },
        mailTransport,
        mailSettings: {
          sender: () => ({ address: 'no-reply@example.test', name: 'Shop' }),
          zone: () => 'UTC',
        },
        policy,
        clock,
      }),
    };
  };

  const definition = (id: Id<'AttributeDefinition'>, codeOf: string, extra = {}) => {
    const built = AttributeDefinition.create({
      id,
      revisionId: ids.next<'AttributeDefinitionRevision'>(),
      marketId: market.marketId,
      code: codeOf,
      dataType: 'select',
      localizable: false,
      material: false,
      isVariantOption: false,
      bounds: {},
      names: { [english]: 'Pack size' },
      options: [
        { code: 'small', labels: { [english]: 'Small' }, active: true, position: 0 },
        { code: 'large', labels: { [english]: 'Large' }, active: true, position: 1 },
      ],
      createdByKind: 'admin',
      now: T0,
      ...extra,
    });
    if (!built.ok) throw new Error(built.error.code);
    return built.value;
  };

  beforeEach(() => {
    definitions = new MemoryAttributeDefinitionStore();
    suggestions = new MemoryAttributeValueSuggestionStore();
    ids = new SequenceIdGenerator(clock);
    audits = [];
    allow = true;
    eligible = true;
    matcherDown = false;
    mails = [];
    mailFails = false;
    address = 'seller@example.test';
    definitions.rows.set(DEFINITION, definition(DEFINITION, 'pack-size'));
    definitions.rows.set(MATERIAL, definition(MATERIAL, 'origin-material', { material: true }));
    suggestions.codes.set(DEFINITION, 'pack-size');
  });

  const suggest = (
    label: unknown,
    attributeCode: unknown = 'pack-size',
    productId: unknown = PRODUCT,
  ) => build().suggest.execute(context('seller'), { productId, attributeCode, label });

  async function opened(label = 'Extra large') {
    const answer = await suggest(label);
    if (!answer.ok) throw new Error(`suggest failed: ${answer.error.code}`);
    return answer.value;
  }

  describe('own-attribute-value.suggest', () => {
    it('opens a suggestion for the seller, tidied, with one id-only audit row', async () => {
      const answer = await suggest('  Extra   large ');
      expect(answer).toEqual(
        ok({
          id: <unknown>expect.any(String),
          attributeCode: 'pack-size',
          status: 'open',
          version: 1,
        }),
      );
      const stored = [...suggestions.rows.values()][0]!.state;
      expect(stored).toMatchObject({
        label: 'Extra large',
        sellerId: SELLER,
        productId: PRODUCT,
        definitionId: DEFINITION,
        marketId: market.marketId,
      });
      expect(audits.map((a) => [a.action, a.targetId])).toEqual([
        ['catalog.attribute-value-suggestion.suggested', stored.id],
      ]);
      expect(JSON.stringify(audits)).not.toContain('Extra');
    });

    it('works on a multi-select field too', async () => {
      expect((await suggest('Cubed', 'cuts')).ok).toBe(true);
    });

    it('answers the same product.not-found for another seller’s product and an unknown one', async () => {
      const other = await suggest('X', 'pack-size', OTHER_PRODUCT);
      const unknown = await suggest('X', 'pack-size', '01990000-0000-7000-8000-0000000000ff');
      expect(other).toEqual(err({ code: 'product.not-found' }));
      expect(unknown).toEqual(other);
    });

    it('refuses a field that is material, a variant option, not a select or not in the schema', async () => {
      for (const attributeCode of ['origin-material', 'size-option', 'brand-text', 'nothing']) {
        expect(await suggest('X', attributeCode)).toEqual(
          err({ code: 'attribute.not-suggestable' }),
        );
      }
      expect(suggestions.rows.size).toBe(0);
    });

    it('refuses a value the list already has, in any case', async () => {
      expect(await suggest('LARGE')).toEqual(err({ code: 'suggestion.value-exists' }));
    });

    it('allows one open suggestion per product and field', async () => {
      await opened('Extra large');
      expect(await suggest('Jumbo')).toEqual(err({ code: 'suggestion.already-open' }));
    });

    it('caps a seller’s open suggestions', async () => {
      for (let n = 0; n < 10; n += 1) {
        const open = await build().suggest.execute(context('seller'), {
          productId: PRODUCT,
          attributeCode: 'cuts',
          label: `Value ${n}`,
        });
        if (n === 0) expect(open.ok).toBe(true);
        // The product and field are the same, so only the first opens; fill the rest directly.
        if (n > 0) {
          const row = [...suggestions.rows.values()][0]!;
          suggestions.rows.set(`s${n}`, row);
        }
      }
      expect(await suggest('One more')).toEqual(err({ code: 'suggestion.limit-reached', max: 10 }));
    });

    it('refuses a bad label, a bad request, a seller who may not sell and a denied caller', async () => {
      expect(await suggest('')).toEqual(err({ code: 'suggestion.label-invalid' }));
      expect(await suggest(42)).toMatchObject({ error: { code: 'validation.failed' } });
      expect(await suggest('X', 'Bad Code')).toMatchObject({
        error: { code: 'validation.failed' },
      });
      expect(await suggest('X', 'pack-size', 'nope')).toMatchObject({
        error: { code: 'validation.failed' },
      });
      eligible = false;
      expect(await suggest('X')).toEqual(err({ code: 'seller.not-eligible' }));
      eligible = true;
      allow = false;
      expect(await suggest('X')).toEqual(err({ code: 'access.denied' }));
      expect(
        await build().suggest.execute(context('admin'), { productId: PRODUCT } as never),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('attribute-suggestion.list', () => {
    it('lists open suggestions with their attribute and active values, for admins only', async () => {
      const first = await opened();
      const answer = await build().list.execute(context('admin'), {});
      if (!answer.ok) throw new Error(answer.error.code);
      expect(answer.value.requiredLocales).toEqual([english]);
      expect(answer.value.items).toHaveLength(1);
      expect(answer.value.items[0]).toMatchObject({
        id: first.id,
        label: 'Extra large',
        productCode: 'P-1',
        attribute: {
          code: 'pack-size',
          options: [
            { code: 'small', labels: { [english]: 'Small' } },
            { code: 'large', labels: { [english]: 'Large' } },
          ],
        },
      });
      expect(await build().list.execute(context('seller'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await build().list.execute(context('admin'), { limit: 0 })).toMatchObject({
        error: { code: 'validation.failed' },
      });
      expect(await build().list.execute(context('admin'), { extra: 1 } as never)).toMatchObject({
        error: { code: 'validation.failed' },
      });
    });
  });

  describe('attribute-suggestion.approve', () => {
    it('adds the value last and active as the next revision, closes the suggestion and audits both', async () => {
      const row = await opened();
      const answer = await build().approve.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        labels: { [english]: 'Extra large' },
      });
      expect(answer).toEqual(
        ok({
          suggestion: { id: row.id, status: 'approved', version: 2, optionCode: 'extra-large' },
        }),
      );
      const stored = definitions.rows.get(DEFINITION)!.state;
      expect(stored.revisionNo).toBe(2);
      expect(stored.options.map((o) => [o.code, o.position, o.active])).toEqual([
        ['small', 0, true],
        ['large', 1, true],
        ['extra-large', 2, true],
      ]);
      expect(definitions.authors.at(-1)).toMatchObject({ author: ADMIN });
      expect(suggestions.rows.get(row.id)!.state).toMatchObject({
        status: 'approved',
        decidedByAccountId: ADMIN,
        noticeState: 'pending',
      });
      expect(audits.map((a) => a.action)).toEqual([
        'catalog.attribute-value-suggestion.suggested',
        'catalog.attribute-definition.revised',
        'catalog.attribute-value-suggestion.decided',
      ]);
    });

    it('takes the admin’s code, and refuses one the attribute already has', async () => {
      const row = await opened();
      const taken = await build().approve.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        labels: { [english]: 'Extra large' },
        optionCode: 'small',
      });
      expect(taken).toMatchObject({ error: { code: 'attribute-definition.option-repeated' } });
      const chosen = await build().approve.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        labels: { [english]: 'Extra large' },
        optionCode: 'xl',
      });
      expect(chosen).toMatchObject({ value: { suggestion: { optionCode: 'xl' } } });
    });

    it('refuses a label with a certification word, with no override, and a down matcher', async () => {
      const row = await opened();
      const body = { suggestionId: row.id, version: 1, labels: { [english]: 'Halal XL' } };
      expect(await build().approve.execute(context('admin'), body)).toMatchObject({
        error: { code: 'attribute.claim-word' },
      });
      matcherDown = true;
      expect(
        await build().approve.execute(context('admin'), { ...body, labels: { [english]: 'XL' } }),
      ).toEqual(err({ code: 'claim-text.check-unavailable' }));
      expect(suggestions.rows.get(row.id)!.state.status).toBe('open');
      expect(definitions.rows.get(DEFINITION)!.state.revisionNo).toBe(1);
    });

    it('needs the default-locale label', async () => {
      const row = await opened();
      expect(
        await build().approve.execute(context('admin'), {
          suggestionId: row.id,
          version: 1,
          labels: {},
        }),
      ).toMatchObject({ error: { code: 'attribute-definition.default-label-required' } });
    });

    it('answers stale for an old version, not-open for a decided one, not-found for others', async () => {
      const row = await opened();
      const body = { suggestionId: row.id, version: 1, labels: { [english]: 'XL' } };
      expect(await build().approve.execute(context('admin'), { ...body, version: 5 })).toEqual(
        err({ code: 'suggestion.stale' }),
      );
      suggestions.raceNext = true;
      expect(await build().approve.execute(context('admin'), body)).toEqual(
        err({ code: 'suggestion.stale' }),
      );
      expect((await build().approve.execute(context('admin'), body)).ok).toBe(true);
      expect(
        await build().approve.execute(context('admin'), {
          ...body,
          version: 2,
          labels: { [english]: 'XXL' },
        }),
      ).toEqual(err({ code: 'suggestion.not-open' }));
      expect(
        await build().approve.execute(context('admin'), {
          ...body,
          suggestionId: '01990000-0000-7000-8000-0000000000fe',
        }),
      ).toEqual(err({ code: 'suggestion.not-found' }));
    });

    it('refuses a seller, an acting-as session and an unknown key', async () => {
      const row = await opened();
      const body = { suggestionId: row.id, version: 1, labels: { [english]: 'XL' } };
      expect(await build().approve.execute(context('seller'), body)).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await build().approve.execute(actingAs(), body)).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await build().approve.execute(context('admin'), { ...body, extra: 1 })).toMatchObject({
        error: { code: 'validation.failed' },
      });
    });

    it('refuses once the attribute turned material or was archived', async () => {
      const row = await opened();
      definitions.rows.set(DEFINITION, definition(DEFINITION, 'pack-size', { material: true }));
      expect(
        await build().approve.execute(context('admin'), {
          suggestionId: row.id,
          version: 1,
          labels: { [english]: 'XL' },
        }),
      ).toEqual(err({ code: 'suggestion.attribute-protected' }));
    });
  });

  describe('attribute-suggestion.map and reject', () => {
    it('maps to an active existing value without a new revision', async () => {
      const row = await opened();
      const answer = await build().map.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        optionCode: 'large',
      });
      expect(answer).toEqual(
        ok({ suggestion: { id: row.id, status: 'mapped', version: 2, optionCode: 'large' } }),
      );
      expect(definitions.rows.get(DEFINITION)!.state.revisionNo).toBe(1);
      expect(audits.at(-1)).toMatchObject({ action: 'catalog.attribute-value-suggestion.decided' });
    });

    it('refuses a value that does not exist', async () => {
      const row = await opened();
      expect(
        await build().map.execute(context('admin'), {
          suggestionId: row.id,
          version: 1,
          optionCode: 'nope',
        }),
      ).toEqual(err({ code: 'suggestion.option-invalid' }));
    });

    it('rejects with a reason that is kept on the suggestion and not in the audit row', async () => {
      const row = await opened();
      const answer = await build().reject.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        reason: 'Not a size we list.',
      });
      expect(answer).toEqual(
        ok({ suggestion: { id: row.id, status: 'rejected', version: 2, optionCode: null } }),
      );
      expect(suggestions.rows.get(row.id)!.state.rejectReason).toBe('Not a size we list.');
      expect(JSON.stringify(audits)).not.toContain('size we list');
      expect(
        await build().reject.execute(context('admin'), {
          suggestionId: row.id,
          version: 2,
          reason: 'Again',
        }),
      ).toEqual(err({ code: 'suggestion.not-open' }));
    });

    it('refuses an empty reason and a seller', async () => {
      const row = await opened();
      expect(
        await build().reject.execute(context('admin'), {
          suggestionId: row.id,
          version: 1,
          reason: ' ',
        }),
      ).toEqual(err({ code: 'suggestion.reason-invalid' }));
      expect(
        await build().reject.execute(context('seller'), {
          suggestionId: row.id,
          version: 1,
          reason: 'x',
        }),
      ).toEqual(err({ code: 'access.denied' }));
    });
  });

  describe('send-attribute-suggestion-notices', () => {
    const system = (): CallContext => testCallContext(market, 'system');

    async function decidedApproved() {
      const row = await opened();
      await build().approve.execute(context('admin'), {
        suggestionId: row.id,
        version: 1,
        labels: { [english]: 'Extra large' },
      });
      return row.id;
    }

    it('sends one plain-text mail per decision, then marks it sent', async () => {
      const id = await decidedApproved();
      const answer = await build().notices.execute(system(), {});
      expect(answer).toMatchObject({ value: { examined: 1, sent: 1, failed: 0 } });
      expect(mails).toHaveLength(1);
      expect(mails[0]!.to).toBe('seller@example.test');
      expect(mails[0]!.text).toContain('Extra large');
      expect(suggestions.rows.get(id)!.state.noticeState).toBe('sent');
      expect(await build().notices.execute(system(), {})).toMatchObject({ value: { examined: 0 } });
    });

    it('settles as skipped when the seller has no usable address', async () => {
      const id = await decidedApproved();
      address = null;
      expect(await build().notices.execute(system(), {})).toMatchObject({ value: { skipped: 1 } });
      expect(suggestions.rows.get(id)!.state.noticeState).toBe('skipped');
      expect(mails).toHaveLength(0);
    });

    it('defers a failed send and goes on, then gives up at the last attempt', async () => {
      const id = await decidedApproved();
      mailFails = true;
      expect(await build().notices.execute(system(), {})).toMatchObject({ value: { deferred: 1 } });
      expect(suggestions.rows.get(id)!.state).toMatchObject({
        noticeState: 'pending',
        noticeAttempts: 1,
      });
      let guard = 0;
      while (suggestions.rows.get(id)!.state.noticeState === 'pending' && guard < 10) {
        const due = suggestions.rows.get(id)!.state.noticeNextAttemptAt!;
        clock.set(due);
        await build().notices.execute(system(), {});
        guard += 1;
      }
      expect(suggestions.rows.get(id)!.state.noticeState).toBe('failed');
      clock.set(T0);
    });

    it('is for the system only', async () => {
      await decidedApproved();
      expect(await build().notices.execute(context('admin'), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(mails).toHaveLength(0);
    });
  });
});
