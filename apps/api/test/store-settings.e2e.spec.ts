import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { StoreSettingsMinimumOrderHistory } from '../src/modules/sellers/application/use-cases/store-settings-minimum-order-history.use-case';
import { StoreSettingsRead } from '../src/modules/sellers/application/use-cases/store-settings-read.use-case';
import { StoreSettingsSaveDelivery } from '../src/modules/sellers/application/use-cases/store-settings-save-delivery.use-case';
import { StoreSettingsSaveMinimumOrder } from '../src/modules/sellers/application/use-cases/store-settings-save-minimum-order.use-case';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's store settings over HTTP (sellers design 18; CRT-05): the real guards, the real
// controller and a real seller session (identity's database ports as in-memory fakes). The two
// use cases are recording stubs for the mapping tests (their behaviour is in their spec); one
// test keeps the real use cases to prove the wiring and the gate: a seller whose file is not
// approved is refused, a visitor is 401. The approved path on PostgreSQL is in
// test/db/sellers-minimum-order.db-spec.ts.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const fakes = new IdentityFakes();

type Failure = { code: string; [key: string]: unknown };

/** A use case that records its calls and answers the result a test chose. */
class Stub {
  calls: { context: CallContext; input: unknown }[] = [];
  next: Result<unknown, Failure> = { ok: true, value: {} };
  execute(context: CallContext, input: unknown): Promise<Result<unknown, Failure>> {
    this.calls.push({ context, input });
    return Promise.resolve(this.next);
  }
}

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('the seller store settings over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const stubs = { read: new Stub(), save: new Stub(), delivery: new Stub(), history: new Stub() };
  const http = () => request(app.getHttpServer());

  async function boot(stubbed: boolean) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        const faked = fakes.override(builder);
        return stubbed
          ? faked
              .overrideProvider(StoreSettingsRead)
              .useValue(stubs.read)
              .overrideProvider(StoreSettingsSaveMinimumOrder)
              .useValue(stubs.save)
              .overrideProvider(StoreSettingsSaveDelivery)
              .useValue(stubs.delivery)
              .overrideProvider(StoreSettingsMinimumOrderHistory)
              .useValue(stubs.history)
          : faked;
      },
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'my-file-e2e-0001');

  /** Signs a seller up, confirms the email, and answers the session cookie and CSRF token. */
  async function signedIn(code: string) {
    await app.get(SeedRoles).execute(systemOf(code), {});
    const headers = { 'x-market-id': code, ...panelHeaders(code, 'seller') };
    await http()
      .post('/identity/seller/sign-up')
      .set(headers)
      .send({ displayName: NAME, email: EMAIL, password: PASSWORD })
      .expect(202);
    const event = fakes.events
      .filter((e) => e.type === 'identity.one-time-link-requested.v1')
      .at(-1)!;
    const payload = event.payload as { linkId: Id; accountId: Id };
    await app.get(SendLinkMail).execute(systemOf(code), {
      delivery: {
        eventId:
          `0199dddd-0000-7000-8000-${String(fakes.mails.length + 1).padStart(12, '0')}` as Id<'event'>,
        subscriber: 'identity.link-mail',
        attempt: 1,
      },
      linkId: payload.linkId,
      accountId: payload.accountId,
      purpose: 'verify-email',
      aggregateVersion: event.aggregateVersion,
    });
    const token = /#(ml1_[A-Za-z0-9_-]{43})/.exec(fakes.mails.at(-1)!.text)![1]!;
    const confirmed = await http()
      .post('/identity/seller/confirm-email')
      .set(headers)
      .send({ token, password: PASSWORD })
      .expect(200);
    return {
      code,
      headers: {
        ...headers,
        cookie: cookieOf(confirmed.headers['set-cookie']),
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  beforeEach(() => {
    fakes.reset();
    for (const stub of Object.values(stubs)) {
      stub.calls = [];
      stub.next = { ok: true, value: {} };
    }
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const currency = code === 'AU' ? 'AUD' : 'JPY';
    const view = {
      version: 3,
      minimumOrder: { amount: 2500n, currency },
      currency,
      maximumAmount: 100000n,
      delivery: null,
    };
    const answer = {
      version: 3,
      minimumOrder: { amount: 2500, currency },
      currency,
      maximumAmount: 100000,
      delivery: null,
    };
    const put = (headers: Record<string, string>, body: unknown) =>
      http()
        .put('/sellers/store-settings/minimum-order')
        .set(headers)
        .send(body as object);

    it('reads the settings with the seller of the session, no-store, numbers as numbers', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.read.next = {
        ok: true,
        value: { ...view, minimumOrder: { amount: 2500n, currency: view.currency } },
      };

      const response = await http().get('/sellers/store-settings').set(session.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual(answer);
      expect(stubs.read.calls[0]!.context.market.marketId).toBe(code);
      expect(stubs.read.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
    });

    it('answers a null minimum as null', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.read.next = { ok: true, value: { ...view, minimumOrder: null } };

      const response = await http().get('/sellers/store-settings').set(session.headers);

      expect(response.body).toEqual({ ...answer, minimumOrder: null });
    });

    it('sets the minimum: forwards only the two named fields, CSRF required, no-store', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.save.next = { ok: true, value: view };
      const body = { expectedVersion: 2, minimumOrder: { amount: 2500, currency } };

      const noToken = await put({ ...session.headers, 'x-csrf-token': '' }, body);
      const saved = await put(session.headers, body);

      expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual(answer);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(stubs.save.calls).toHaveLength(1);
      expect(stubs.save.calls[0]!.input).toEqual(body);
    });

    it('clears the minimum with null', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.save.next = { ok: true, value: { ...view, minimumOrder: null } };

      const cleared = await put(session.headers, { expectedVersion: 3, minimumOrder: null });

      expect(cleared.status).toBe(200);
      expect(cleared.body).toEqual({ ...answer, minimumOrder: null });
      expect(stubs.save.calls[0]!.input).toEqual({ expectedVersion: 3, minimumOrder: null });
    });

    it.each([
      [
        'a seller id',
        { expectedVersion: 1, minimumOrder: null, sellerId: 'x' },
        'sellerId',
        'unknown-field',
      ],
      ['no expected version', { minimumOrder: null }, 'expectedVersion', 'required'],
      ['no minimumOrder', { expectedVersion: 1 }, 'minimumOrder', 'required'],
      ['a string version', { expectedVersion: '1', minimumOrder: null }, 'expectedVersion', 'type'],
      [
        'a string amount',
        { expectedVersion: 1, minimumOrder: { amount: '2500', currency: 'AUD' } },
        'minimumOrder.amount',
        'type',
      ],
      [
        'a missing currency',
        { expectedVersion: 1, minimumOrder: { amount: 2500 } },
        'minimumOrder.currency',
        'required',
      ],
      [
        'an unknown money field',
        { expectedVersion: 1, minimumOrder: { amount: 1, currency: 'AUD', extra: 1 } },
        'minimumOrder.extra',
        'unknown-field',
      ],
      ['an array body', [], '', 'type'],
    ])(
      'refuses %s as validation.failed without calling the use case',
      async (_n, body, path, fieldCode) => {
        await boot(true);
        const session = await signedIn(code);

        const response = await put(session.headers, body);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: expect.arrayContaining([{ path, code: fieldCode }]) as unknown },
        });
        expect(stubs.save.calls).toHaveLength(0);
      },
    );

    it('refuses a body that is not JSON with 415', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await http()
        .put('/sellers/store-settings/minimum-order')
        .set(session.headers)
        .set('content-type', 'text/plain')
        .send('expectedVersion=1');

      expect(response.status).toBe(415);
      expect(stubs.save.calls).toHaveLength(0);
    });

    it.each([
      ['minimum-order.amount', 400],
      ['minimum-order.currency', 400],
      ['conflict.stale', 409],
      ['file.not-found', 404],
      ['access.denied', 403],
      ['sellers.unavailable', 503],
      ['access.unavailable', 503],
    ])('maps %s to %i', async (errorCode, status) => {
      await boot(true);
      const session = await signedIn(code);
      stubs.save.next = { ok: false, error: { code: errorCode } };

      const response = await put(session.headers, { expectedVersion: 1, minimumOrder: null });

      expect(response.status).toBe(status);
      expect((response.body as { code: string }).code).toBe(errorCode);
    });

    it('answers a throttled save with 429 and Retry-After', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.save.next = { ok: false, error: { code: 'request.throttled', retryAfterSeconds: 7 } };

      const response = await put(session.headers, { expectedVersion: 1, minimumOrder: null });

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('7');
      expect(response.body).toMatchObject({ details: { retryAfterSeconds: 7 } });
    });

    describe('delivery terms (package e)', () => {
      const terms = { day: 'next-day', from: '08:00', to: '12:00', cutoff: '14:00' };
      const stored = { day: 'next-day', fromMinute: 480, toMinute: 720, cutoffMinute: 840 };
      const putDelivery = (headers: Record<string, string>, body: unknown) =>
        http()
          .put('/sellers/store-settings/delivery')
          .set(headers)
          .send(body as object);

      it('reads the saved terms as clock text', async () => {
        await boot(true);
        const session = await signedIn(code);
        stubs.read.next = { ok: true, value: { ...view, delivery: stored } };

        const response = await http().get('/sellers/store-settings').set(session.headers);

        expect(response.body).toEqual({ ...answer, delivery: terms });
      });

      it('sets the terms: forwards only the two named fields, CSRF required, no-store', async () => {
        await boot(true);
        const session = await signedIn(code);
        stubs.delivery.next = { ok: true, value: { ...view, delivery: stored } };
        const body = { expectedVersion: 2, delivery: terms };

        const noToken = await putDelivery({ ...session.headers, 'x-csrf-token': '' }, body);
        const saved = await putDelivery(session.headers, body);

        expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({ ...answer, delivery: terms });
        expect(saved.headers['cache-control']).toBe('no-store');
        expect(stubs.delivery.calls).toHaveLength(1);
        expect(stubs.delivery.calls[0]!.input).toEqual(body);
      });

      it('clears the terms with null', async () => {
        await boot(true);
        const session = await signedIn(code);
        stubs.delivery.next = { ok: true, value: view };

        const cleared = await putDelivery(session.headers, { expectedVersion: 3, delivery: null });

        expect(cleared.status).toBe(200);
        expect(cleared.body).toEqual(answer);
        expect(stubs.delivery.calls[0]!.input).toEqual({ expectedVersion: 3, delivery: null });
      });

      it.each([
        [
          'a seller id',
          { expectedVersion: 1, delivery: null, sellerId: 'x' },
          'sellerId',
          'unknown-field',
        ],
        ['no expected version', { delivery: null }, 'expectedVersion', 'required'],
        ['no delivery', { expectedVersion: 1 }, 'delivery', 'required'],
        [
          'a missing cut-off',
          { expectedVersion: 1, delivery: { ...terms, cutoff: undefined } },
          'delivery.cutoff',
          'required',
        ],
        [
          'a numeric time',
          { expectedVersion: 1, delivery: { ...terms, from: 800 } },
          'delivery.from',
          'type',
        ],
        [
          'an unknown field',
          { expectedVersion: 1, delivery: { ...terms, zone: 'UTC' } },
          'delivery.zone',
          'unknown-field',
        ],
        ['a string delivery', { expectedVersion: 1, delivery: 'next-day' }, 'delivery', 'type'],
        ['an array body', [], '', 'type'],
      ])(
        'refuses %s as validation.failed without calling the use case',
        async (_n, body, path, fieldCode) => {
          await boot(true);
          const session = await signedIn(code);

          const response = await putDelivery(session.headers, body);

          expect(response.status).toBe(400);
          expect(response.body).toMatchObject({
            code: 'validation.failed',
            details: { fields: expect.arrayContaining([{ path, code: fieldCode }]) as unknown },
          });
          expect(stubs.delivery.calls).toHaveLength(0);
        },
      );

      it('refuses a body that is not JSON with 415', async () => {
        await boot(true);
        const session = await signedIn(code);

        const response = await http()
          .put('/sellers/store-settings/delivery')
          .set(session.headers)
          .set('content-type', 'text/plain')
          .send('expectedVersion=1');

        expect(response.status).toBe(415);
        expect(stubs.delivery.calls).toHaveLength(0);
      });

      it.each([
        ['delivery.day', 400],
        ['delivery.window', 400],
        ['delivery.cutoff', 400],
        ['conflict.stale', 409],
        ['file.not-found', 404],
        ['access.denied', 403],
        ['sellers.unavailable', 503],
      ])('maps %s to %i', async (errorCode, status) => {
        await boot(true);
        const session = await signedIn(code);
        stubs.delivery.next = { ok: false, error: { code: errorCode } };

        const response = await putDelivery(session.headers, { expectedVersion: 1, delivery: null });

        expect(response.status).toBe(status);
        expect((response.body as { code: string }).code).toBe(errorCode);
      });
    });

    const history = (headers: Record<string, string>, query = '') =>
      http().get(`/sellers/store-settings/minimum-order/history${query}`).set(headers);

    it('reads the minimum-order history: newest first, numbers as numbers, the ISO instant, no-store', async () => {
      await boot(true);
      const session = await signedIn(code);
      const changedBy = {
        displayName: NAME,
        role: { kind: 'system', seedCode: 'seller-owner', name: null },
      };
      stubs.history.next = {
        ok: true,
        value: {
          items: [
            {
              changedAt: Temporal.Instant.from('2026-10-20T03:00:00Z'),
              changedBy,
              before: { amount: 2500n, currency },
              after: null,
            },
            {
              changedAt: Temporal.Instant.from('2026-10-19T03:00:00Z'),
              changedBy: null,
              before: null,
              after: { amount: 2500n, currency },
            },
          ],
          next: '01990000-0000-7000-8000-000000000001',
        },
      };

      const response = await history(
        session.headers,
        '?after=01990000-0000-7000-8000-000000000009&limit=2',
      );

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        items: [
          {
            changedAt: '2026-10-20T03:00:00Z',
            changedBy,
            before: { amount: 2500, currency },
            after: null,
          },
          {
            changedAt: '2026-10-19T03:00:00Z',
            changedBy: null,
            before: null,
            after: { amount: 2500, currency },
          },
        ],
        next: '01990000-0000-7000-8000-000000000001',
      });
      expect(stubs.history.calls[0]!.input).toEqual({
        after: '01990000-0000-7000-8000-000000000009',
        limit: 2,
      });
      expect(stubs.history.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
    });

    it('passes no page to the use case when the query names none, and a non-numeric limit as invalid', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.history.next = { ok: true, value: { items: [], next: null } };

      await history(session.headers).expect(200, { items: [], next: null });
      await history(session.headers, '?limit=ten');

      expect(stubs.history.calls.map((call) => call.input)).toEqual([
        { after: null, limit: undefined },
        { after: null, limit: 'invalid' },
      ]);
    });

    it.each([
      ['validation.failed', 400],
      ['file.not-found', 404],
      ['access.denied', 403],
      ['sellers.unavailable', 503],
    ])('maps a history %s to %i', async (errorCode, status) => {
      await boot(true);
      const session = await signedIn(code);
      stubs.history.next = {
        ok: false,
        error:
          errorCode === 'validation.failed'
            ? { code: errorCode, fields: [{ path: 'after', code: 'unknown' }] }
            : { code: errorCode },
      };

      const response = await history(session.headers);

      expect(response.status).toBe(status);
      expect((response.body as { code: string }).code).toBe(errorCode);
    });

    it('refuses a visitor with 401; the gate holds back a pending seller and admits an approved one (real use cases)', async () => {
      await boot(false);
      const session = await signedIn(code);
      const body = { expectedVersion: 1, minimumOrder: null };

      const visitor = await put({ 'x-market-id': code, ...panelHeaders(code, 'seller') }, body);
      const visitorRead = await http()
        .get('/sellers/store-settings')
        .set({ 'x-market-id': code, ...panelHeaders(code, 'seller') });
      const save = await put(session.headers, body);
      const read = await http().get('/sellers/store-settings').set(session.headers);
      const visitorHistory = await history({
        'x-market-id': code,
        ...panelHeaders(code, 'seller'),
      });
      const read2 = await history(session.headers);

      expect(visitor.status).toBe(401);
      expect(visitorRead.status).toBe(401);
      expect(visitorHistory.status).toBe(401);
      // AU requires approval, so a just-registered seller is pending and the gate refuses it
      // (403) before the use case reads anything. ZZ approves at once: the gate admits it and the
      // use case runs; sellers' repositories have no database here, so only "not refused" is
      // asserted (the admitted path is in test/db/sellers-minimum-order.db-spec.ts).
      for (const answer of [save, read, read2]) {
        if (code === 'AU') expect(answer.status).toBe(403);
        else expect([401, 403]).not.toContain(answer.status);
      }
    });
  });
});
