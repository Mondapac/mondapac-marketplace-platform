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

// The two-person request to clear `material` over HTTP (catalog design 8.2; attributes A2 part 3):
// the real guards, controllers, gate with the real role seed and use cases; the stores, the claim
// matcher and the claim locales as in-memory fakes. Proved in both Market fixtures: a Catalogue
// Moderator (no edit key) can neither ask nor list; one editor asks (201), the same editor cannot
// confirm (403 relaxation.same-admin), a second editor sees it in the list and confirms (200,
// Material off); the requester withdraws; a stale version is 409; the CSRF token, JSON and closed
// bodies; and the OpenAPI document.

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
const SECOND = id<'Account'>(0xb703);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('material relaxation over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const store = new MemoryAttributeDefinitionStore();
  const relaxations = new MemoryAttributeRelaxationStore();
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
          .useValue(relaxations)
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
      [SECOND, 'second', EDITOR_ROLE],
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
    relaxations.reset();
    covered = null;
  });
  afterEach(async () => {
    await app?.close();
  });

  const RELAXATIONS = '/catalog/admin/attribute-relaxations';

  it('documents the four relaxation routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[`${ATTRIBUTES}/{attributeId}/relaxation-requests`]).toHaveProperty(
      'post',
    );
    expect(document.paths[RELAXATIONS]).toHaveProperty('get');
    expect(document.paths[`${RELAXATIONS}/{requestId}/confirm`]).toHaveProperty('post');
    expect(document.paths[`${RELAXATIONS}/{requestId}/cancel`]).toHaveProperty('post');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const locale = localeOf(code);

    /** A published material attribute, created and published by EDITOR. */
    async function publishedMaterial() {
      const editor = adminSession(code, EDITOR, 2);
      const created = await http()
        .post(ATTRIBUTES)
        .set(editor)
        .send({
          dataType: 'select',
          names: { [locale]: 'Allergens' },
          material: true,
          options: [{ code: 'nuts', labels: { [locale]: 'Nuts' } }],
        })
        .expect(201);
      const attribute = (created.body as { attribute: { id: string; version: number } }).attribute;
      const published = await http()
        .post(`${ATTRIBUTES}/${attribute.id}/publish`)
        .set(editor)
        .send({ version: attribute.version })
        .expect(200);
      return {
        editor,
        attribute: (published.body as { attribute: { id: string; version: number } }).attribute,
      };
    }

    it('asks with one editor and confirms with another; Material is off at once', async () => {
      await boot();
      await seeded(code);
      const { editor, attribute } = await publishedMaterial();
      const asked = await http()
        .post(`${ATTRIBUTES}/${attribute.id}/relaxation-requests`)
        .set(editor)
        .send({ version: attribute.version, kind: 'clear-material' })
        .expect(201);
      const req = (asked.body as { request: { id: string; version: number; status: string } })
        .request;
      expect(req.status).toBe('open');

      const own = await http()
        .post(`${RELAXATIONS}/${req.id}/confirm`)
        .set(editor)
        .send({ version: req.version })
        .expect(403);
      expect(own.body).toEqual({ statusCode: 403, code: 'relaxation.same-admin' });

      const second = adminSession(code, SECOND, 3);
      const listed = await http().get(RELAXATIONS).set(second).expect(200);
      expect(listed.headers['cache-control']).toBe('no-store');
      expect(listed.body).toMatchObject({
        requests: [
          {
            id: req.id,
            mine: false,
            attribute: { id: attribute.id, code: 'allergens' },
            allowedActions: { confirm: { allowed: true } },
          },
        ],
      });
      const stale = await http()
        .post(`${RELAXATIONS}/${req.id}/confirm`)
        .set(second)
        .send({ version: 7 })
        .expect(409);
      expect(stale.body).toEqual({ statusCode: 409, code: 'relaxation.stale' });
      const confirmed = await http()
        .post(`${RELAXATIONS}/${req.id}/confirm`)
        .set(second)
        .send({ version: req.version })
        .expect(200);
      expect(confirmed.body).toMatchObject({
        request: { id: req.id, status: 'confirmed' },
        attribute: { id: attribute.id, status: 'active' },
      });
      expect(store.rows.get(attribute.id)!.state.material).toBe(false);
      expect((await http().get(RELAXATIONS).set(second).expect(200)).body).toEqual({
        requests: [],
      });
    });

    it('lets the requester withdraw, and only them', async () => {
      await boot();
      await seeded(code);
      const { editor, attribute } = await publishedMaterial();
      const asked = await http()
        .post(`${ATTRIBUTES}/${attribute.id}/relaxation-requests`)
        .set(editor)
        .send({ version: attribute.version, kind: 'clear-material' })
        .expect(201);
      const req = (asked.body as { request: { id: string; version: number } }).request;
      const other = await http()
        .post(`${RELAXATIONS}/${req.id}/cancel`)
        .set(adminSession(code, SECOND, 3))
        .send({ version: req.version })
        .expect(403);
      expect(other.body).toEqual({ statusCode: 403, code: 'relaxation.not-requester' });
      await http()
        .post(`${RELAXATIONS}/${req.id}/cancel`)
        .set(editor)
        .send({ version: req.version })
        .expect(200);
      const again = await http()
        .post(`${ATTRIBUTES}/${attribute.id}/relaxation-requests`)
        .set(editor)
        .send({ version: attribute.version, kind: 'clear-material' })
        .expect(201);
      expect((again.body as { request: { status: string } }).request.status).toBe('open');
      const twice = await http()
        .post(`${ATTRIBUTES}/${attribute.id}/relaxation-requests`)
        .set(editor)
        .send({ version: attribute.version, kind: 'clear-material' })
        .expect(409);
      expect(twice.body).toEqual({ statusCode: 409, code: 'relaxation.already-open' });
    });

    it('refuses a moderator, a missing CSRF token, a non-JSON body and an unknown key', async () => {
      await boot();
      await seeded(code);
      const { attribute } = await publishedMaterial();
      const path = `${ATTRIBUTES}/${attribute.id}/relaxation-requests`;
      const moderator = adminSession(code, MODERATOR, 1);
      expect(
        (
          await http()
            .post(path)
            .set(moderator)
            .send({ version: 2, kind: 'clear-material' })
            .expect(403)
        ).body,
      ).toEqual({ statusCode: 403, code: 'access.denied' });
      expect((await http().get(RELAXATIONS).set(moderator).expect(403)).body).toEqual({
        statusCode: 403,
        code: 'access.denied',
      });
      const editor = adminSession(code, EDITOR, 4);
      const noCsrf: Record<string, string> = { ...editor };
      delete noCsrf['x-csrf-token'];
      await http().post(path).set(noCsrf).send({ version: 2, kind: 'clear-material' }).expect(403);
      await http()
        .post(path)
        .set(editor)
        .set('content-type', 'text/plain')
        .send('version=2')
        .expect(415);
      const extra = await http()
        .post(path)
        .set(editor)
        .send({ version: 2, kind: 'clear-material', material: false })
        .expect(400);
      expect((extra.body as { code: string }).code).toBe('validation.failed');
      expect(relaxations.rows.size).toBe(0);
    });
  });
});
