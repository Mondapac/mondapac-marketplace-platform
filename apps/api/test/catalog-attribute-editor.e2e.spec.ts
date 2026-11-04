import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_DEFINITION_STORE } from '../src/modules/catalog/application/ports/attribute-definition.store';
import { ATTRIBUTE_RELAXATION_STORE } from '../src/modules/catalog/application/ports/attribute-relaxation.store';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryAttributeDefinitionStore,
  MemoryAttributeRelaxationStore,
  claimLocalesOf,
  halalOnlyMatcher,
} from './support/catalog-attribute-editor-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The attribute editor over HTTP (attributes plan, package A2): the real guards, controller, gate
// with the real role seed and use cases; the store, the claim matcher and the claim locales as
// in-memory fakes. Proved in both Market fixtures: the protected edit key is in no default role, so
// a Catalogue Moderator reads but cannot write; an admin with a custom role holding the key
// creates a draft (201), publishes it, saves a revision, and is refused a stale version (409), a
// claim word (422, fields only) and a locale the vocabulary cannot read (422); the CSRF token,
// JSON and closed bodies; and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xb701);
const EDITOR = id<'Account'>(0xb702);
const EDITOR_ROLE = id<'Role'>(0xb801);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('attribute editor over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const store = new MemoryAttributeDefinitionStore();
  let covered: readonly string[] | null = null;
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
          .useValue(store)
          .overrideProvider(ATTRIBUTE_RELAXATION_STORE)
          .useValue(new MemoryAttributeRelaxationStore())
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalOnlyMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              claimLocalesOf(covered ?? localesOf(context.market.marketId)).covered(
                context as never,
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'attr-0002'), {});
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
        id: id<'RoleAssignment'>(0xe800 + n),
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
        id: id<'Session'>(0xf800 + n),
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

  const ATTRIBUTES = '/catalog/admin/attributes';

  beforeEach(() => {
    fakes.reset();
    store.reset();
    covered = null;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the four editor routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[ATTRIBUTES]).toHaveProperty('post');
    expect(document.paths[`${ATTRIBUTES}/{attributeId}`]).toHaveProperty('put');
    expect(document.paths[`${ATTRIBUTES}/{attributeId}/publish`]).toHaveProperty('post');
    expect(document.paths[`${ATTRIBUTES}/{attributeId}/discard`]).toHaveProperty('post');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const locale = localeOf(code);
    const body = (overrides: Record<string, unknown> = {}) => ({
      dataType: 'select',
      names: { [locale]: 'Pack size' },
      options: [{ code: 'g500', labels: { [locale]: '500 g' } }],
      ...overrides,
    });

    it('keeps the protected edit key out of every default role; a moderator cannot write', async () => {
      await boot();
      await seeded(code);
      for (const role of [...fakes.roles.values()].filter(
        (r) => r.marketId === code && r.kind !== 'custom',
      )) {
        expect(role.permissionKeys).not.toContain('catalog.attribute.edit');
      }
      const refused = await http()
        .post(ATTRIBUTES)
        .set(adminSession(code, MODERATOR, 1))
        .send(body())
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('creates a draft, publishes it and saves a revision; an old version is 409', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 2);
      const created = await http().post(ATTRIBUTES).set(editor).send(body()).expect(201);
      expect(created.body).toEqual({
        attribute: {
          id: <unknown>expect.any(String),
          code: 'pack-size',
          status: 'draft',
          version: 1,
          revisionNo: 1,
        },
      });
      const attributeId = (created.body as { attribute: { id: string } }).attribute.id;
      expect(store.authors.map((a) => a.author)).toEqual([EDITOR]);

      const published = await http()
        .post(`${ATTRIBUTES}/${attributeId}/publish`)
        .set(editor)
        .send({ version: 1 })
        .expect(200);
      expect(published.body).toMatchObject({ attribute: { status: 'active', version: 2 } });

      const saved = await http()
        .put(`${ATTRIBUTES}/${attributeId}`)
        .set(editor)
        .send({
          version: 2,
          names: { [locale]: 'Pack size' },
          options: [
            { code: 'g500', labels: { [locale]: '500 g' } },
            { code: 'kg1', labels: { [locale]: '1 kg' } },
          ],
          searchable: true,
        })
        .expect(200);
      expect(saved.body).toMatchObject({ attribute: { version: 3, revisionNo: 2 } });

      const stale = await http()
        .put(`${ATTRIBUTES}/${attributeId}`)
        .set(editor)
        .send({ version: 2, names: { [locale]: 'Pack' } })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'attribute.stale' });

      const discard = await http()
        .post(`${ATTRIBUTES}/${attributeId}/discard`)
        .set(editor)
        .send({ version: 3 })
        .expect(409);
      expect(discard.body).toMatchObject({ code: 'attribute-definition.not-draft' });
    }, 30_000);

    it('refuses a claim word with the field paths only, and a locale the check cannot read', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 3);
      const claim = await http()
        .post(ATTRIBUTES)
        .set(editor)
        .send(body({ names: { [locale]: 'Halal pack' } }))
        .expect(422);
      expect(claim.body).toEqual({
        statusCode: 422,
        code: 'attribute.claim-word',
        details: { fields: [{ path: `names.${locale}`, code: 'claim-word' }] },
      });
      expect(JSON.stringify(claim.body)).not.toMatch(/halal/i);

      covered = [];
      const uncheckable = await http().post(ATTRIBUTES).set(editor).send(body()).expect(422);
      expect(uncheckable.body).toMatchObject({ code: 'attribute.locale-uncheckable' });
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('needs the CSRF token, JSON and a closed body', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 4);
      const withoutCsrf: Record<string, string> = { ...editor };
      delete withoutCsrf['x-csrf-token'];
      await http().post(ATTRIBUTES).set(withoutCsrf).send(body()).expect(403);
      await http()
        .post(ATTRIBUTES)
        .set({ ...editor, 'content-type': 'text/plain' })
        .send('x')
        .expect(415);
      const unknown = await http()
        .post(ATTRIBUTES)
        .set(editor)
        .send(body({ colour: 'red' }))
        .expect(400);
      expect(unknown.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'colour', code: 'unknown-field' }] },
      });
      await http()
        .put(`${ATTRIBUTES}/not-an-id`)
        .set(editor)
        .send({ version: 1, names: { [locale]: 'A' } })
        .expect(404);
      expect(store.rows.size).toBe(0);
    }, 30_000);
  });
});
