import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The signed-in customer's own profile over HTTP (buyer account backend): the display name and
// the storefront look, read back from the session summary. The real guards, controllers and use
// cases, with identity's database ports as in-memory fakes (no database in `pnpm test`). The
// columns' PostgreSQL round trip is in test/db/customer-profile.db-spec.ts. nestjs-pino captures
// the log lines of a file's first application only, so the logging test comes first.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Shopper@Example.com';
const fakes = new IdentityFakes();

const ACCOUNT_ID = (code: string) =>
  `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-000000000001` as Id<'Account'>;

function seed(code: string, overrides: Partial<AccountState> = {}): void {
  const now = Temporal.Instant.from('2026-10-01T00:00:00Z');
  fakes.seedAccount({
    id: ACCOUNT_ID(code),
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
}

const cookieOf = (setCookie: unknown): string => {
  const [line] = Array.isArray(setCookie) ? (setCookie as string[]) : [String(setCookie)];
  return line!.split(';', 1)[0]!;
};

describe('customer profile over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      override: (builder) => fakes.override(builder),
    }));
  }

  /** Signs the seeded customer in; the session cookie and its CSRF token. */
  async function signedIn(market: string): Promise<{ cookie: string; csrfToken: string }> {
    const response = await http()
      .post('/identity/customer/sign-in')
      .set({ 'x-market-id': market })
      .send({ email: EMAIL, password: PASSWORD });
    expect(response.status).toBe(200);
    return {
      cookie: cookieOf(response.headers['set-cookie']),
      csrfToken: (response.body as { csrfToken: string }).csrfToken,
    };
  }

  const put = (market: string, path: string, body: unknown, headers: Record<string, string>) =>
    http()
      .put(`/identity/customer/${path}`)
      .set({ 'x-market-id': market, ...headers })
      .send(body as object);

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs outcome codes with the correlation id, never the name', async () => {
    await boot();
    seed('AU');
    const { cookie, csrfToken } = await signedIn('AU');

    const response = await put(
      'AU',
      'profile/display-name',
      { displayName: 'Zahra Unique' },
      { cookie, 'x-csrf-token': csrfToken },
    );

    expect(response.status).toBe(200);
    const line = logLines.find((entry) => entry.msg === 'identity.customer-change-display-name');
    expect(line).toMatchObject({
      outcome: 'ok',
      marketId: 'AU',
      correlationId: response.headers['x-correlation-id'] as string,
    });
    expect(JSON.stringify(logLines)).not.toContain('Zahra Unique');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('sets the name and the look, then the session summary carries both', async () => {
      await boot();
      seed(code);
      const { cookie, csrfToken } = await signedIn(code);
      const auth = { cookie, 'x-csrf-token': csrfToken };

      const before = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie });
      expect(before.body).toMatchObject({ displayName: null, appearance: null });

      const named = await put(code, 'profile/display-name', { displayName: ' Amina ' }, auth);
      expect(named.status).toBe(200);
      expect(named.body).toEqual({ code: 'display-name-changed', changed: true });
      expect(named.headers['cache-control']).toBe('no-store');

      const look = await put(code, 'profile/appearance', { palette: 'C', textSize: 'large' }, auth);
      expect(look.status).toBe(200);
      expect(look.body).toEqual({ code: 'storefront-appearance-changed', changed: true });

      const again = await put(
        code,
        'profile/appearance',
        { palette: 'C', textSize: 'large' },
        auth,
      );
      expect(again.body).toEqual({ code: 'storefront-appearance-changed', changed: false });

      const after = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie });
      expect(after.status).toBe(200);
      expect(after.body).toMatchObject({
        displayName: 'Amina',
        appearance: { palette: 'C', textSize: 'large' },
      });
    });

    it('clears a part of the look with null', async () => {
      await boot();
      seed(code, { appearance: { palette: 'A', textSize: 'small' } });
      const { cookie, csrfToken } = await signedIn(code);

      const response = await put(
        code,
        'profile/appearance',
        { palette: null, textSize: 'small' },
        { cookie, 'x-csrf-token': csrfToken },
      );

      expect(response.status).toBe(200);
      const summary = await http()
        .get('/identity/customer/session')
        .set({ 'x-market-id': code, cookie });
      expect(summary.body).toMatchObject({ appearance: { palette: null, textSize: 'small' } });
    });

    it('refuses without the CSRF token or without a session', async () => {
      await boot();
      seed(code);
      const { cookie } = await signedIn(code);

      const noToken = await put(
        code,
        'profile/appearance',
        { palette: 'A', textSize: null },
        {
          cookie,
        },
      );
      expect(noToken.status).toBe(403);
      expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });

      const noSession = await put(code, 'profile/display-name', { displayName: 'Amina' }, {});
      expect(noSession.status).toBe(401);
      expect(fakes.accounts.get(ACCOUNT_ID(code))!.displayName).toBeNull();
    });

    it.each([
      [{ palette: 'E', textSize: null }, [{ path: 'palette', code: 'invalid' }]],
      [{ palette: 'A', textSize: 'huge' }, [{ path: 'textSize', code: 'invalid' }]],
      [{ palette: 1, textSize: null }, [{ path: 'palette', code: 'type' }]],
      [{ palette: 'A' }, [{ path: 'textSize', code: 'required' }]],
      [{ palette: 'A', textSize: null, accountId: 'x' }, [{ path: '', code: 'unknown-field' }]],
      [[], [{ path: '', code: 'type' }]],
    ])('refuses the look %j', async (body, fields) => {
      await boot();
      seed(code);
      const { cookie, csrfToken } = await signedIn(code);

      const response = await put(code, 'profile/appearance', body, {
        cookie,
        'x-csrf-token': csrfToken,
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields },
      });
      expect(fakes.accounts.get(ACCOUNT_ID(code))!.appearance ?? null).toBeNull();
    });

    it('refuses a URL-like name and a body of another media type', async () => {
      await boot();
      seed(code);
      const { cookie, csrfToken } = await signedIn(code);
      const auth = { cookie, 'x-csrf-token': csrfToken };

      const urlLike = await put(
        code,
        'profile/display-name',
        { displayName: 'shop.example.com' },
        auth,
      );
      expect(urlLike.status).toBe(400);
      expect(urlLike.body).toMatchObject({ code: 'validation.failed' });

      const text = await http()
        .put('/identity/customer/profile/appearance')
        .set({ 'x-market-id': code, ...auth, 'content-type': 'text/plain' })
        .send('palette=A');
      expect(text.status).toBe(415);
    });
  });

  it('documents both routes in the OpenAPI document', async () => {
    ({ app } = await createTestApp({
      env: { API_DOCS_ENABLED: 'true' },
      override: (builder) => fakes.override(builder),
    }));

    const response = await http().get('/docs-json').expect(200);
    const paths = (response.body as { paths: Record<string, Record<string, unknown>> }).paths;

    expect(paths['/identity/customer/profile/display-name']?.put).toBeDefined();
    expect(paths['/identity/customer/profile/appearance']?.put).toBeDefined();
  });
});
