import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SaveDraft } from '../src/modules/catalog/application/working-copy/save-draft.service';
import { SubmitProduct } from '../src/modules/catalog/application/revisions/submit-product.service';
import { ATTRIBUTE_REPOSITORY } from '../src/modules/catalog/application/ports/attribute.repository';
import { PRODUCT_REPOSITORY } from '../src/modules/catalog/application/ports/product.repository';
import type { Product } from '../src/modules/catalog/domain/product';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The PLATFORM product routes over HTTP (catalog design 4.2, 8.2; slice 6): the real guards,
// controller, gate and the real `platform-product.create` use case, with identity's database ports
// and catalog's product and attribute stores as in-memory fakes. The two services behind save-draft
// and submit are scripted (their behaviour is covered by their own specs and the database specs);
// what is proved here is the route: the session, the CSRF token, the key, the closed body, the
// status of each refusal and the log line.

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xa000 + n)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const PRODUCT = '01990000-0000-7000-8000-00000000c001';

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('platform product routes over HTTP (integration, slice 6)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let stored: Product[];
  let saveResult: unknown;
  let submitResult: unknown;
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(PRODUCT_REPOSITORY)
          .useValue({
            nextProductCode: () =>
              Promise.resolve(`P${String(stored.length + 1).padStart(8, '0')}`),
            add: (_m: unknown, product: Product) => {
              stored.push(product);
              return Promise.resolve();
            },
            findById: () => Promise.resolve(null),
            save: () => Promise.resolve(),
          })
          .overrideProvider(ATTRIBUTE_REPOSITORY)
          .useValue({ loadSchema: () => Promise.resolve({ fields: [] }) })
          .overrideProvider(SaveDraft)
          .useValue({ execute: () => Promise.resolve(saveResult) })
          .overrideProvider(SubmitProduct)
          .useValue({ execute: () => Promise.resolve(submitResult) }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'roles-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      fakes.seedAccount({
        id: idOf,
        marketId,
        population: 'admin',
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, VIEWER, 'viewer');
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf100 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const send = (
    method: 'post' | 'put',
    code: string,
    path: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    http()
      [method](`/catalog/admin/platform-products${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin'), ...headers })
      .send(body as object);

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    stored = [];
    saveResult = ok({ variantIds: [], refusedFields: [] });
    submitResult = ok({ revisionId: PRODUCT, revisionNo: 1, published: true });
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the three routes and their error codes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const base = '/catalog/admin/platform-products';
    expect(document.paths[base]?.post?.responses).toHaveProperty('201');
    expect(document.paths[`${base}/{productId}/draft`]?.put?.responses).toHaveProperty('429');
    expect(document.paths[`${base}/{productId}/submit`]?.post?.responses).toHaveProperty('422');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('creates a draft product for the Platform Administrator and logs the outcome', async () => {
      await boot();
      await seeded(code);

      const created = await send(
        'post',
        code,
        '',
        { typeCode: 'simple' },
        sessionOf(code, ROOT, 1),
      );

      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ productCode: 'P00000001' });
      expect((created.body as { variantIds: string[] }).variantIds).toHaveLength(1);
      expect(stored).toHaveLength(1);
      expect(stored[0]!.state).toMatchObject({
        scope: 'PLATFORM',
        marketId: code,
        status: 'draft',
      });
      expect(
        logLines.find((l) => l.msg === 'catalog.platform-product-create' && l.outcome),
      ).toMatchObject({
        outcome: 'ok',
        marketId: code,
        correlationId: created.headers['x-correlation-id'] as string,
      });
    });

    it('refuses without the CSRF token, without a session and without the key, storing nothing', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const viewer = sessionOf(code, VIEWER, 2);

      const noCsrf = await send('post', code, '', { typeCode: 'simple' }, { cookie: root.cookie });
      expect(noCsrf.status).toBe(403);
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const anonymous = await send('post', code, '', { typeCode: 'simple' }, {});
      expect(anonymous.status).toBe(401);
      for (const [method, path, body] of [
        ['post', '', { typeCode: 'simple' }],
        ['put', `/${PRODUCT}/draft`, { content: {}, variantIds: [] }],
        ['post', `/${PRODUCT}/submit`, { replacePending: false }],
      ] as const) {
        const denied = await send(method, code, path, body, viewer);
        expect(denied.status).toBe(403);
        expect(denied.body).toEqual({ statusCode: 403, code: 'access.denied' });
      }
      expect(stored).toHaveLength(0);
    });

    it('refuses an unknown field, a missing field and a non-JSON body with a 400 or 415', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const extra = await send('post', code, '', { typeCode: 'simple', scope: 'SELLER' }, root);
      expect(extra.status).toBe(400);
      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'scope', code: 'unknown-field' }] },
      });
      const missing = await send('post', code, '', {}, root);
      expect(missing.body).toMatchObject({
        details: { fields: [{ path: 'typeCode', code: 'required' }] },
      });
      const array = await send('post', code, '', [], root);
      expect(array.status).toBe(400);
      const text = await http()
        .post('/catalog/admin/platform-products')
        .set({
          'x-market-id': code,
          ...panelHeaders(code, 'admin'),
          ...root,
          'content-type': 'text/plain',
        })
        .send('typeCode=simple');
      expect(text.status).toBe(415);
      expect(stored).toHaveLength(0);
    });

    it('answers 422 for a type the Market does not offer', async () => {
      await boot();
      await seeded(code);
      const nope = await send('post', code, '', { typeCode: 'nope' }, sessionOf(code, ROOT, 1));
      expect(nope.status).toBe(422);
      expect(nope.body).toEqual({ statusCode: 422, code: 'product.type-not-offered' });
    });

    it('saves a draft and lists the texts that kept their last value', async () => {
      await boot();
      await seeded(code);
      saveResult = ok({
        variantIds: [PRODUCT],
        refusedFields: [
          {
            field: 'product.name',
            ref: null,
            locale: 'en-AU',
            code: 'claim-text.found',
            hits: [{ typeCode: 'halal', span: { fromToken: 0, toToken: 1 } }],
          },
        ],
      });
      const saved = await send(
        'put',
        code,
        `/${PRODUCT}/draft`,
        { content: { name: {} }, variantIds: [null] },
        sessionOf(code, ROOT, 1),
      );
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual({
        variantIds: [PRODUCT],
        refusedFields: [
          {
            field: 'product.name',
            ref: null,
            locale: 'en-AU',
            code: 'claim-text.found',
            hits: [{ typeCode: 'halal', span: { fromToken: 0, toToken: 1 } }],
          },
        ],
      });
      expect(logLines.find((l) => l.msg === 'catalog.platform-product-save-draft')).toMatchObject({
        outcome: 'ok',
        marketId: code,
      });
    });

    it('maps the refusals of the draft save and the submit to their statuses', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);
      const draft = (path = PRODUCT) =>
        send('put', code, `/${path}/draft`, { content: {}, variantIds: [] }, root);
      const submit = (path = PRODUCT) =>
        send('post', code, `/${path}/submit`, { replacePending: true }, root);

      saveResult = err({ code: 'request.throttled', retryAfterSeconds: 60 });
      const throttled = await draft();
      expect(throttled.status).toBe(429);
      expect(throttled.headers['retry-after']).toBe('60');
      expect(throttled.body).toEqual({
        statusCode: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: 60 },
      });
      saveResult = err({ code: 'conflict.stale' });
      expect((await draft()).status).toBe(409);
      saveResult = err({ code: 'product.not-found' });
      expect((await draft()).status).toBe(404);
      submitResult = err({
        code: 'claim-text.refused',
        fields: [
          { field: 'product.name', ref: null, locale: 'en-AU', code: 'claim-text.found', hits: [] },
        ],
      });
      const refused = await submit();
      expect(refused.status).toBe(422);
      expect(refused.body).toMatchObject({ code: 'claim-text.refused' });
      submitResult = err({
        code: 'revision.not-ready',
        issues: [{ path: 'name', code: 'required' }],
      });
      const notReady = await submit();
      expect(notReady.status).toBe(422);
      expect(notReady.body).toMatchObject({
        details: { issues: [{ path: 'name', code: 'required' }] },
      });
      submitResult = err({ code: 'access.unavailable' });
      expect((await submit()).status).toBe(503);
      submitResult = err({ code: 'something.new' });
      expect((await submit()).status).toBe(500);
    });

    it('answers a malformed product id as an unknown product and submits with a closed body', async () => {
      await boot();
      await seeded(code);
      const root = sessionOf(code, ROOT, 1);

      const malformed = await send(
        'post',
        code,
        '/not-an-id/submit',
        { replacePending: false },
        root,
      );
      expect(malformed.status).toBe(404);
      expect(malformed.body).toEqual({ statusCode: 404, code: 'product.not-found' });
      const submitted = await send(
        'post',
        code,
        `/${PRODUCT}/submit`,
        { replacePending: false },
        root,
      );
      expect(submitted.status).toBe(200);
      expect(submitted.body).toEqual({ revisionId: PRODUCT, revisionNo: 1, published: true });
      const open = await send(
        'post',
        code,
        `/${PRODUCT}/submit`,
        { replacePending: false, x: 1 },
        root,
      );
      expect(open.status).toBe(400);
    });
  });
});
