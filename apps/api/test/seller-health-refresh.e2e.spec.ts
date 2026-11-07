import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { RefreshOwnSellerHealth } from '../src/modules/sellers/application/use-cases/refresh-own-seller-health.use-case';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's "Refresh now" for their health over HTTP (seller health, HLT-03): the real guards,
// controller and a real seller session (identity's database ports as in-memory fakes). The use
// case is a recording stub for the mapping tests (its behaviour is in
// refresh-own-seller-health.use-case.spec.ts); the real use case is kept for one test to prove the
// wiring and the gate: a seller whose file is not approved is refused.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const fakes = new IdentityFakes();

type Failure = { code: string; [key: string]: unknown };

/** A use case that records its calls and answers the result a test chose. */
class Stub {
  calls: { context: CallContext; input: unknown }[] = [];
  next: Result<unknown, Failure> = { ok: true, value: { status: 'queued' } };
  execute(context: CallContext, input: unknown): Promise<Result<unknown, Failure>> {
    this.calls.push({ context, input });
    return Promise.resolve(this.next);
  }
}

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('the seller health refresh over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const stub = new Stub();
  const http = () => request(app.getHttpServer());

  async function boot(stubbed: boolean) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        const faked = fakes.override(builder);
        return stubbed ? faked.overrideProvider(RefreshOwnSellerHealth).useValue(stub) : faked;
      },
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'health-refresh-0001');

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
      headers: {
        ...headers,
        cookie: cookieOf(confirmed.headers['set-cookie']),
        'x-csrf-token': (confirmed.body as { csrfToken: string }).csrfToken,
      },
    };
  }

  beforeEach(() => {
    fakes.reset();
    stub.calls = [];
    stub.next = { ok: true, value: { status: 'queued' } };
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const refresh = (headers: Record<string, string>) =>
      http().post('/sellers/own-health/refresh').set(headers);

    it('answers 202 with the status, no-store, for the seller of the session', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await refresh(session.headers);

      expect(response.status).toBe(202);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ status: 'queued' });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]!.context.market.marketId).toBe(code);
      expect(stub.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
    });

    it('answers 429 with Retry-After while the cooldown runs', async () => {
      await boot(true);
      const session = await signedIn(code);
      stub.next = { ok: false, error: { code: 'request.throttled', retryAfterSeconds: 600 } };

      const response = await refresh(session.headers);

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('600');
      expect(response.headers['cache-control']).toBe('no-store');
      expect((response.body as { code: string }).code).toBe('request.throttled');
    });

    it('answers 503 when the store is unavailable', async () => {
      await boot(true);
      const session = await signedIn(code);
      stub.next = { ok: false, error: { code: 'sellers.unavailable' } };

      const response = await refresh(session.headers);

      expect(response.status).toBe(503);
    });

    it('refuses a post without the CSRF token with 403, calling nothing', async () => {
      await boot(true);
      const session = await signedIn(code);
      const noCsrf: Record<string, string> = { ...session.headers };
      delete noCsrf['x-csrf-token'];

      const forged = await refresh(noCsrf);

      expect(forged.status).toBe(403);
      expect(stub.calls).toEqual([]);
    });

    it('refuses a visitor with 401; the gate holds back a pending seller (real use case)', async () => {
      await boot(false);
      const session = await signedIn(code);
      const visitor = { 'x-market-id': code, ...panelHeaders(code, 'seller') };

      const anonymous = await http().post('/sellers/own-health/refresh').set(visitor);
      const own = await refresh(session.headers);

      expect(anonymous.status).toBe(401);
      // AU requires approval, so a just-registered seller is pending and the gate refuses it (403)
      // before the use case reads anything. ZZ approves at once, so the gate admits the seller and
      // the use case runs; this suite has no database for sellers' repositories, so it fails closed
      // with 503 `sellers.unavailable` (the admitted path is proved in the unit spec).
      if (code === 'AU') {
        expect(own.status).toBe(403);
      } else {
        expect(own.status).toBe(503);
        expect((own.body as { code: string }).code).toBe('sellers.unavailable');
      }
    });
  });
});
