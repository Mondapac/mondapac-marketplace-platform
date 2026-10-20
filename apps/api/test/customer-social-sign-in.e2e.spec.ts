import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Social sign-in over HTTP: the real guards, controllers, use cases and flow secrets, with
// identity's database ports and the sign-in provider as in-memory fakes (no database or network
// in `pnpm test`). The provider adapter's own checks (ID token) are
// src/modules/identity/infrastructure/social/oidc-sign-in-providers.spec.ts.

const EMAIL = 'Shopper@Example.com';
const PASSWORD = 'correct horse battery staple';
const fakes = new IdentityFakes();

const RETURN_PAGE: Record<string, string> = {
  AU: 'https://storefront.au.mondapac.test/account/sign-in',
  ZZ: 'https://storefront.zz.test/konto/anmelden',
};

function seed(code: string, overrides: Partial<AccountState> = {}): Id<'Account'> {
  const now = Temporal.Instant.from('2026-10-01T00:00:00Z');
  const id = `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-000000000001` as Id<'Account'>;
  fakes.seedAccount({
    id,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: null,
    status: 'active',
    emailVerifiedAt: now,
    existingAccountNoticeAt: null,
    signedUpAt: now,
    createdAt: now,
    version: 1,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: now },
    ...overrides,
  });
  return id;
}

/** The `name=value` of every Set-Cookie line, by name. */
const cookiesOf = (setCookie: unknown): Record<string, { pair: string; line: string }> => {
  const lines = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return Object.fromEntries(
    lines.map((line) => {
      const pair = line.split(';', 1)[0]!;
      return [pair.split('=', 1)[0]!, { pair, line }];
    }),
  );
};

describe('customer social sign-in over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      override: (builder) => fakes.override(builder),
    }));
  }

  /** Starts a flow: the flow cookie's `name=value` and the state the provider got. */
  async function start(code: string, intent?: string, headers: Record<string, string> = {}) {
    const response = await http()
      .get(
        `/identity/customer/social/google/start${intent === undefined ? '' : `?intent=${intent}`}`,
      )
      .set({ 'x-market-id': code, ...headers });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    const flow = cookiesOf(response.headers['set-cookie'])[`__Host-social-customer-${code}`]!;
    return {
      response,
      flow: flow.pair,
      flowLine: flow.line,
      state: location.searchParams.get('state')!,
    };
  }

  function callback(code: string, query: string, cookie: string) {
    return http()
      .get(`/identity/customer/social/google/callback?${query}`)
      .set({ 'x-market-id': code, cookie });
  }

  /** The `social` outcome of a callback's redirect, checking it goes to the Market's page. */
  const outcomeOf = (code: string, response: request.Response): string | null => {
    expect(response.status).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(`${location.origin}${location.pathname}`).toBe(RETURN_PAGE[code]);
    return location.searchParams.get('social');
  };

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the code, the state, the secret or the email', async () => {
    await boot();
    fakes.provider.configured = true;
    const { flow, state } = await start('AU');

    const response = await callback('AU', `code=the-code-123&state=${state}`, flow);

    expect(outcomeOf('AU', response)).toBe('signed-up');
    const line = logLines.find((l) => l.msg === 'identity.customer-social-callback');
    expect(line).toMatchObject({ outcome: 'signed-up', marketId: 'AU' });
    const all = JSON.stringify(logLines);
    for (const secret of [
      'the-code-123',
      state,
      flow.split('=')[1]!,
      'shopper@example.com',
      'google-sub-1',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const session = `__Host-session-customer-${code}`;
    const flowName = `__Host-social-customer-${code}`;

    it('offers no provider and refuses to start one until it is configured', async () => {
      await boot();

      const providers = await http()
        .get('/identity/customer/social/providers')
        .set({ 'x-market-id': code });
      expect(providers.status).toBe(200);
      expect(providers.body).toEqual({ providers: [] });
      const started = await http()
        .get('/identity/customer/social/google/start')
        .set({ 'x-market-id': code });
      expect(started.status).toBe(404);
      expect(started.body).toEqual({ statusCode: 404, code: 'sign-in-provider.not-configured' });
      const unknown = await http()
        .get('/identity/customer/social/myspace/start')
        .set({ 'x-market-id': code });
      expect(unknown.status).toBe(404);

      fakes.provider.configured = true;
      const configured = await http()
        .get('/identity/customer/social/providers')
        .set({ 'x-market-id': code });
      expect(configured.body).toEqual({ providers: ['google'] });
    });

    it('starts: the flow cookie (ten minutes, __Host-, Lax) and a redirect with state and PKCE', async () => {
      await boot();
      fakes.provider.configured = true;

      const { response, flowLine, state } = await start(code);

      expect(flowLine).toMatch(
        new RegExp(
          `^${flowName}=s[A-Za-z0-9_-]{43}; Max-Age=600; Path=/; Secure; HttpOnly; SameSite=Lax$`,
        ),
      );
      expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.headers.location).toContain('code_challenge=');
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('signs up a new customer, verified, then signs the same person in again', async () => {
      await boot();
      fakes.provider.configured = true;
      const first = await start(code);

      const signedUp = await callback(code, `code=c1&state=${first.state}`, first.flow);

      expect(outcomeOf(code, signedUp)).toBe('signed-up');
      const cookies = cookiesOf(signedUp.headers['set-cookie']);
      expect(cookies[flowName]!.line).toContain('Max-Age=0');
      expect(cookies[session]!.line).toMatch(
        /Max-Age=\d+; Path=\/; Secure; HttpOnly; SameSite=Lax$/,
      );
      const accounts = [...fakes.accounts.values()].filter((a) => a.marketId === code);
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ population: 'customer', status: 'active' });
      expect(accounts[0]!.emailVerifiedAt).not.toBeNull();
      expect([...fakes.externalIdentities.values()]).toEqual([
        expect.objectContaining({
          accountId: accounts[0]!.id,
          provider: 'google',
          subject: 'google-sub-1',
        }),
      ]);
      expect(fakes.events.map((e) => e.type)).toContain('identity.customer-account-registered.v1');
      // The exchange used the verifier derived from this browser's flow, not the state.
      expect(fakes.provider.exchanges[0]!.codeVerifier).not.toBe(first.state);

      const described = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie: cookies[session]!.pair });
      expect(described.status).toBe(200);
      expect(described.body).toMatchObject({
        population: 'customer',
        email: 'shopper@example.com',
      });

      const second = await start(code);
      const signedIn = await callback(code, `code=c2&state=${second.state}`, second.flow);
      expect(outcomeOf(code, signedIn)).toBe('signed-in');
      expect([...fakes.accounts.values()].filter((a) => a.marketId === code)).toHaveLength(1);
      expect(fakes.records.filter((r) => r.outcome === 'signed-in')).toHaveLength(2);
    });

    it("refuses another browser's state, a missing flow cookie and the other intent's cookie", async () => {
      await boot();
      fakes.provider.configured = true;
      const mine = await start(code);
      const theirs = await start(code);

      const wrongState = await callback(code, `code=c&state=${theirs.state}`, mine.flow);
      expect(outcomeOf(code, wrongState)).toBe('failed');
      const noCookie = await callback(code, `code=c&state=${mine.state}`, 'other=1');
      expect(outcomeOf(code, noCookie)).toBe('expired');
      const asLink = mine.flow.replace('=s', '=l');
      const otherIntent = await callback(code, `code=c&state=${mine.state}`, asLink);
      expect(outcomeOf(code, otherIntent)).toBe('sign-in-required');
      expect(fakes.provider.exchanges).toHaveLength(0);
      expect(fakes.accounts.size).toBe(0);
    });

    it('answers cancelled when the person declines at the provider', async () => {
      await boot();
      fakes.provider.configured = true;
      const { flow } = await start(code);

      const response = await callback(code, 'error=access_denied', flow);

      expect(outcomeOf(code, response)).toBe('cancelled');
    });

    it('never connects to an existing password account by itself: link-required', async () => {
      await boot();
      fakes.provider.configured = true;
      seed(code);
      const { flow, state } = await start(code);

      const response = await callback(code, `code=c&state=${state}`, flow);

      expect(outcomeOf(code, response)).toBe('link-required');
      expect(cookiesOf(response.headers['set-cookie'])[session]).toBeUndefined();
      expect(fakes.externalIdentities.size).toBe(0);
      expect(fakes.accounts.size).toBe(1);
    });

    it('creates nothing for an email the provider did not verify, or a failed exchange', async () => {
      await boot();
      fakes.provider.configured = true;
      fakes.provider.identity = { ...fakes.provider.identity, emailVerified: false };
      const one = await start(code);
      expect(outcomeOf(code, await callback(code, `code=c&state=${one.state}`, one.flow))).toBe(
        'email-unverified',
      );

      fakes.provider.identity = { ...fakes.provider.identity, emailVerified: true };
      fakes.provider.failure = 'provider.rejected';
      const two = await start(code);
      expect(outcomeOf(code, await callback(code, `code=c&state=${two.state}`, two.flow))).toBe(
        'failed',
      );
      expect(fakes.accounts.size).toBe(0);
    });

    it('connects the provider after a password sign-in, then signs in with it', async () => {
      await boot();
      fakes.provider.configured = true;
      const accountId = seed(code);
      const signedIn = await http()
        .post('/identity/customer/sign-in')
        .set({ 'x-market-id': code })
        .send({ email: EMAIL, password: PASSWORD });
      const sessionPair = cookiesOf(signedIn.headers['set-cookie'])[session]!.pair;

      const withoutSession = await start(code, 'link');
      expect(
        outcomeOf(
          code,
          await callback(code, `code=c&state=${withoutSession.state}`, withoutSession.flow),
        ),
      ).toBe('sign-in-required');

      const link = await start(code, 'link');
      expect(link.flowLine).toMatch(new RegExp(`^${flowName}=l`));
      const linked = await callback(
        code,
        `code=c&state=${link.state}`,
        `${link.flow}; ${sessionPair}`,
      );
      expect(outcomeOf(code, linked)).toBe('linked');
      expect([...fakes.externalIdentities.values()]).toEqual([
        expect.objectContaining({ accountId, subject: 'google-sub-1' }),
      ]);

      const again = await start(code);
      expect(outcomeOf(code, await callback(code, `code=c&state=${again.state}`, again.flow))).toBe(
        'signed-in',
      );
      expect(fakes.accounts.size).toBe(1);
    });

    it('refuses to connect a provider account with another email, or one already connected', async () => {
      await boot();
      fakes.provider.configured = true;
      seed(code);
      const signedIn = await http()
        .post('/identity/customer/sign-in')
        .set({ 'x-market-id': code })
        .send({ email: EMAIL, password: PASSWORD });
      const sessionPair = cookiesOf(signedIn.headers['set-cookie'])[session]!.pair;

      fakes.provider.identity = {
        subject: 'google-sub-2',
        email: 'someone@else.test',
        emailVerified: true,
      };
      const mismatch = await start(code, 'link');
      expect(
        outcomeOf(
          code,
          await callback(
            code,
            `code=c&state=${mismatch.state}`,
            `${mismatch.flow}; ${sessionPair}`,
          ),
        ),
      ).toBe('email-mismatch');

      fakes.externalIdentities.set(`${code}|google|google-sub-1`, {
        marketId: code,
        accountId: '0199cccc-0000-7000-8000-000000000009' as Id<'Account'>,
        provider: 'google',
        subject: 'google-sub-1',
        createdAt: Temporal.Instant.from('2026-10-01T00:00:00Z'),
      });
      fakes.provider.identity = { subject: 'google-sub-1', email: EMAIL, emailVerified: true };
      const taken = await start(code, 'link');
      expect(
        outcomeOf(
          code,
          await callback(code, `code=c&state=${taken.state}`, `${taken.flow}; ${sessionPair}`),
        ),
      ).toBe('already-linked');
    });

    it('refuses a disabled account that signs in with its provider', async () => {
      await boot();
      fakes.provider.configured = true;
      const accountId = seed(code, { status: 'disabled' });
      fakes.externalIdentities.set(`${code}|google|google-sub-1`, {
        marketId: code,
        accountId,
        provider: 'google',
        subject: 'google-sub-1',
        createdAt: Temporal.Instant.from('2026-10-01T00:00:00Z'),
      });
      const { flow, state } = await start(code);

      const response = await callback(code, `code=c&state=${state}`, flow);

      expect(outcomeOf(code, response)).toBe('account-disabled');
      expect(fakes.sessions.size).toBe(0);
    });
  });
});
