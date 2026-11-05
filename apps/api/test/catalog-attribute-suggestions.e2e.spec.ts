import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_DEFINITION_STORE } from '../src/modules/catalog/application/ports/attribute-definition.store';
import { ATTRIBUTE_VALUE_SUGGESTION_STORE } from '../src/modules/catalog/application/ports/attribute-value-suggestion.store';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import { AttributeDefinition } from '../src/modules/catalog/domain/attribute-definition';
import { AttributeValueSuggestion } from '../src/modules/catalog/domain/attribute-value-suggestion';
import { SUGGESTION_ADMIN_STATUS } from '../src/modules/catalog/presentation/attribute-suggestion.controller';
import { OWN_SUGGESTION_STATUS } from '../src/modules/catalog/presentation/own-attribute-suggestion.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryAttributeDefinitionStore,
  claimLocalesOf,
  halalOnlyMatcher,
} from './support/catalog-attribute-editor-fakes';
import { MemoryAttributeValueSuggestionStore } from './support/catalog-suggestion-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The value-suggestion routes over HTTP (attributes plan, package A5): the real guards,
// controllers, gate with the real role seed and use cases; the stores, the claim matcher and the
// product reader as in-memory fakes. Proved in both Market fixtures: a Catalogue Moderator lists
// and decides; an attribute editor without the decision key cannot; approve adds the value (200),
// a stale version and a decided suggestion are 409, a claim word is 422; map and reject; the CSRF
// token, JSON and closed bodies; an anonymous seller request is 401; and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-03T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xc701);
const EDITOR = id<'Account'>(0xc702);
const EDITOR_ROLE = id<'Role'>(0xc801);
const DEFINITION = id<'AttributeDefinition'>(0xc901);
const PRODUCT = id<'Product'>(0xca01);
const SELLER = id<'Seller'>(0xcb01);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps each suggestion refusal to its HTTP status', () => {
  expect(SUGGESTION_ADMIN_STATUS).toMatchObject({
    'suggestion.not-found': 404,
    'suggestion.stale': 409,
    'suggestion.not-open': 409,
    'suggestion.attribute-protected': 409,
    'suggestion.option-invalid': 422,
    'suggestion.reason-invalid': 422,
    'attribute.claim-word': 422,
    'validation.failed': 400,
  });
  expect(OWN_SUGGESTION_STATUS).toMatchObject({
    'product.not-found': 404,
    'suggestion.already-open': 409,
    'suggestion.value-exists': 409,
    'suggestion.limit-reached': 422,
    'attribute.not-suggestable': 422,
    'seller.not-eligible': 403,
  });
});

describe('value suggestions over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const definitions = new MemoryAttributeDefinitionStore();
  const suggestions = new MemoryAttributeValueSuggestionStore();
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(ATTRIBUTE_DEFINITION_STORE)
          .useValue(definitions)
          .overrideProvider(ATTRIBUTE_VALUE_SUGGESTION_STORE)
          .useValue(suggestions)
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({ findById: () => Promise.resolve(null) })
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalOnlyMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              claimLocalesOf(localesOf(context.market.marketId)).covered(context as never),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'sugg-0002'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Attribute editor',
      permissionKeys: ['catalog.attribute.view', 'catalog.attribute.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    for (const [accountId, label, roleId] of [
      [MODERATOR, 'moderator', roleOf('catalogue-moderator')],
      [EDITOR, 'editor', EDITOR_ROLE],
    ] as const) {
      n += 1;
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf900 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const QUEUE = '/catalog/admin/attribute-suggestions';

  beforeEach(() => {
    fakes.reset();
    definitions.reset();
    suggestions.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the four admin routes and the two seller routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[QUEUE]).toHaveProperty('get');
    for (const action of ['approve', 'map', 'reject']) {
      expect(document.paths[`${QUEUE}/{suggestionId}/${action}`]).toHaveProperty('post');
    }
    expect(
      document.paths['/catalog/seller/products/{productId}/attribute-suggestions'],
    ).toHaveProperty('post');
    expect(document.paths['/catalog/seller/attribute-suggestions']).toHaveProperty('get');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const locale = localeOf(code);

    /** A published select attribute and one open suggestion for it. */
    function waiting(label = 'Extra large') {
      const definition = AttributeDefinition.create({
        id: DEFINITION,
        revisionId: id<'AttributeDefinitionRevision'>(0xcc01),
        marketId: code as AccountState['marketId'],
        code: 'pack-size',
        dataType: 'select',
        localizable: false,
        material: false,
        isVariantOption: false,
        bounds: {},
        names: { [locale]: 'Pack size' },
        options: [{ code: 'small', labels: { [locale]: 'Small' }, active: true, position: 0 }],
        createdByKind: 'admin',
        now: START,
      });
      if (!definition.ok) throw new Error(definition.error.code);
      definitions.rows.set(DEFINITION, definition.value);
      const suggestion = AttributeValueSuggestion.open({
        id: id<'AttributeValueSuggestion'>(0xcd01),
        marketId: code as AccountState['marketId'],
        definitionId: DEFINITION,
        sellerId: SELLER,
        productId: PRODUCT,
        label,
        now: START,
      });
      if (!suggestion.ok) throw new Error(suggestion.error.code);
      suggestions.rows.set(suggestion.value.state.id, suggestion.value);
      return suggestion.value.state.id;
    }

    it('lists the queue for a moderator, no-store, and refuses a role without the decision key', async () => {
      await boot();
      await seeded(code);
      const suggestionId = waiting();
      const listed = await http()
        .get(QUEUE)
        .set(adminSession(code, MODERATOR, 1))
        .expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({
        requiredLocales: [locale],
        items: [
          {
            id: suggestionId,
            version: 1,
            label: 'Extra large',
            attribute: { code: 'pack-size', options: [{ code: 'small' }] },
          },
        ],
      });
      expect(
        (
          await http()
            .get(QUEUE)
            .set(adminSession(code, EDITOR, 2))
            .expect(403)
        ).body,
      ).toEqual({
        statusCode: 403,
        code: 'access.denied',
      });
      await http()
        .get(QUEUE)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .expect(401);
    });

    it('approves: the value is added, then the same suggestion is 409', async () => {
      await boot();
      await seeded(code);
      const suggestionId = waiting();
      const moderator = adminSession(code, MODERATOR, 1);
      const stale = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(moderator)
        .send({ version: 4, labels: { [locale]: 'Extra large' } })
        .expect(409);
      expect(stale.body).toEqual({ statusCode: 409, code: 'suggestion.stale' });
      const approved = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(moderator)
        .send({ version: 1, labels: { [locale]: 'Extra large' } })
        .expect(200);
      expect(approved.body).toEqual({
        suggestion: { id: suggestionId, status: 'approved', version: 2, optionCode: 'extra-large' },
      });
      expect(definitions.rows.get(DEFINITION)!.state.options.map((o) => o.code)).toEqual([
        'small',
        'extra-large',
      ]);
      const again = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(moderator)
        .send({ version: 2, labels: { [locale]: 'Extra large 2' } })
        .expect(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'suggestion.not-open' });
    });

    it('refuses a label with a certification word (422) and keeps the suggestion open', async () => {
      await boot();
      await seeded(code);
      const suggestionId = waiting();
      const refused = await http()
        .post(`${QUEUE}/${suggestionId}/approve`)
        .set(adminSession(code, MODERATOR, 1))
        .send({ version: 1, labels: { [locale]: 'Halal XL' } })
        .expect(422);
      expect(refused.body).toMatchObject({ code: 'attribute.claim-word' });
      expect(suggestions.rows.get(suggestionId)!.state.status).toBe('open');
    });

    it('maps to an existing value and rejects with a reason', async () => {
      await boot();
      await seeded(code);
      const first = waiting();
      const moderator = adminSession(code, MODERATOR, 1);
      const missing = await http()
        .post(`${QUEUE}/${first}/map`)
        .set(moderator)
        .send({ version: 1, optionCode: 'nope' })
        .expect(422);
      expect(missing.body).toEqual({ statusCode: 422, code: 'suggestion.option-invalid' });
      const mapped = await http()
        .post(`${QUEUE}/${first}/map`)
        .set(moderator)
        .send({ version: 1, optionCode: 'small' })
        .expect(200);
      expect(mapped.body).toMatchObject({ suggestion: { status: 'mapped', optionCode: 'small' } });
      suggestions.reset();
      const second = waiting('Jumbo');
      const empty = await http()
        .post(`${QUEUE}/${second}/reject`)
        .set(moderator)
        .send({ version: 1, reason: '  ' })
        .expect(422);
      expect(empty.body).toEqual({ statusCode: 422, code: 'suggestion.reason-invalid' });
      const rejected = await http()
        .post(`${QUEUE}/${second}/reject`)
        .set(moderator)
        .send({ version: 1, reason: 'Not a size we sell.' })
        .expect(200);
      expect(rejected.body).toMatchObject({ suggestion: { status: 'rejected', optionCode: null } });
      expect(suggestions.rows.get(second)!.state.rejectReason).toBe('Not a size we sell.');
    });

    it('refuses a missing CSRF token, a non-JSON body, an unknown key and an unknown suggestion', async () => {
      await boot();
      await seeded(code);
      const suggestionId = waiting();
      const moderator = adminSession(code, MODERATOR, 1);
      const path = `${QUEUE}/${suggestionId}/reject`;
      const noCsrf: Record<string, string> = { ...moderator };
      delete noCsrf['x-csrf-token'];
      await http().post(path).set(noCsrf).send({ version: 1, reason: 'No.' }).expect(403);
      await http()
        .post(path)
        .set(moderator)
        .set('content-type', 'text/plain')
        .send('version=1')
        .expect(415);
      const extra = await http()
        .post(path)
        .set(moderator)
        .send({ version: 1, reason: 'No.', status: 'approved' })
        .expect(400);
      expect((extra.body as { code: string }).code).toBe('validation.failed');
      const unknown = await http()
        .post(`${QUEUE}/${id<'AttributeValueSuggestion'>(0xcdff)}/reject`)
        .set(moderator)
        .send({ version: 1, reason: 'No.' })
        .expect(404);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'suggestion.not-found' });
      expect(suggestions.rows.get(suggestionId)!.state.status).toBe('open');
    });

    it('answers 401 to anonymous seller requests', async () => {
      await boot();
      await http()
        .post(`/catalog/seller/products/${PRODUCT}/attribute-suggestions`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .send({ attributeCode: 'pack-size', label: 'XL' })
        .expect(401);
      await http()
        .get('/catalog/seller/attribute-suggestions')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') })
        .expect(401);
    });
  });
});
