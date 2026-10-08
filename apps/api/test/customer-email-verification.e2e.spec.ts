import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { RandomLinkTokens } from '../src/modules/identity/infrastructure/links/random-link-tokens';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Customer email verification over HTTP (identity design 3.2, 6.3, 6.6, 6.7, 8.6; `ux.md` A3,
// A4; slice 3): the real guards, controllers and use cases, with identity's database ports and
// the mail transport as in-memory fakes. The PostgreSQL run, with the dispatcher and the mail
// handler, is test/db/email-verification.db-spec.ts. nestjs-pino captures the log lines of a
// file's first application only, so the logging test comes first.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Shopper@Example.com';
const fakes = new IdentityFakes();
const linkTokens = new RandomLinkTokens();

/** A response body as the API answers it: a code and, for a validation error, details. */
const bodyOf = (response: { body: unknown }) =>
  response.body as { readonly code?: string; readonly details?: unknown };

/** An unverified account with an issued `verify-email` link; answers the link's token. */
function seedUnverified(code: string, now = Temporal.Now.instant()): string {
  const accountId =
    `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-000000000001` as Id<'Account'>;
  const created = now.subtract({ hours: 1 });
  const account: AccountState = {
    id: accountId,
    marketId: code as AccountState['marketId'],
    population: 'customer',
    email: { typed: EMAIL, normalized: EMAIL.toLowerCase() },
    displayName: null,
    status: 'active',
    emailVerifiedAt: null,
    existingAccountNoticeAt: null,
    signedUpAt: created,
    createdAt: created,
    version: 1,
    credential: { passwordHash: fakeHashOf(PASSWORD), changedAt: created },
  };
  fakes.seedAccount(account);
  const { token, tokenHash } = linkTokens.issue();
  const linkId = `0199${code === 'AU' ? 'aaaa' : 'bbbb'}-0000-7000-8000-0000000000a1`;
  fakes.links.set(linkId, {
    id: linkId as Id<'OneTimeLink'>,
    marketId: account.marketId,
    accountId,
    purpose: 'verify-email',
    requestedAt: created,
    tokenHash,
    issuedAt: created,
    expiresAt: now.add({ hours: 1 }),
    consumedAt: null,
    version: 2,
  });
  return token;
}

describe('customer email verification over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const http = () => request(app.getHttpServer());
  const confirm = (market: string, body: unknown, type = 'application/json') =>
    http()
      .post('/identity/customer/confirm-email')
      .set({ 'x-market-id': market, 'content-type': type })
      .send(typeof body === 'string' ? body : JSON.stringify(body));
  const resend = (market: string, body: unknown) =>
    http()
      .post('/identity/customer/verification-email')
      .set({ 'x-market-id': market })
      .send(body as object);

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      override: (builder) => fakes.override(builder),
    }));
  }

  beforeEach(() => fakes.reset());
  afterEach(async () => {
    await app.close();
  });

  it('logs outcomes with the correlation id, never the token, the email or the password', async () => {
    await boot();
    const token = seedUnverified('AU');

    const response = await confirm('AU', { token, password: PASSWORD });
    const again = await resend('AU', { email: EMAIL });

    expect([response.status, again.status]).toEqual([200, 202]);
    expect(logLines.find((l) => l.msg === 'identity.customer-confirm-email')).toMatchObject({
      outcome: 'signed-in',
      marketId: 'AU',
      correlationId: response.headers['x-correlation-id'] as string,
    });
    expect(logLines.find((l) => l.msg === 'identity.customer-verification-email')).toMatchObject({
      outcome: 'verification-resend.accepted',
      correlationId: again.headers['x-correlation-id'] as string,
    });
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(token);
    expect(all).not.toContain(EMAIL.toLowerCase());
    expect(all).not.toContain(PASSWORD);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('confirms with the link and the password: the email is verified and the session cookie set', async () => {
      await boot();
      const token = seedUnverified(code);

      const response = await confirm(code, { token, password: PASSWORD });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        code: 'signed-in',
        csrfToken: expect.any(String) as unknown,
      });
      const [setCookie] = response.headers['set-cookie'] as unknown as string[];
      expect(setCookie).toMatch(new RegExp(`^__Host-session-customer-${code}=ms1_`));
      expect(response.headers['cache-control']).toBe('no-store');
      expect(JSON.stringify(response.body)).not.toContain(token);
      const [account] = [...fakes.accounts.values()];
      expect(account!.emailVerifiedAt).not.toBeNull();
      expect(fakes.events.map((e) => e.type)).toEqual(['identity.account-email-verified.v1']);

      // The link is used up: one answer for every cause.
      const reused = await confirm(code, { token, password: PASSWORD });
      expect(reused.status).toBe(400);
      expect(reused.body).toEqual({ statusCode: 400, code: 'link.rejected' });
    });

    it('answers credentials.invalid (401) for a wrong password, and the link stays usable', async () => {
      await boot();
      const token = seedUnverified(code);

      const wrong = await confirm(code, { token, password: 'not the password at all' });
      const right = await confirm(code, { token, password: PASSWORD });

      expect([wrong.status, bodyOf(wrong).code]).toEqual([401, 'credentials.invalid']);
      expect(right.status).toBe(200);
    });

    it('answers link.rejected (400) for an unknown or malformed token', async () => {
      await boot();
      seedUnverified(code);

      for (const token of [linkTokens.issue().token, 'garbage']) {
        const response = await confirm(code, { token, password: PASSWORD });
        expect([response.status, response.body]).toEqual([
          400,
          { statusCode: 400, code: 'link.rejected' },
        ]);
      }
    });

    it('refuses a body that is not the closed JSON object, echoing no value', async () => {
      await boot();

      const extra = await confirm(code, { token: 'x', password: 'y', email: EMAIL });
      const missing = await confirm(code, { token: 'x' });
      const form = await confirm(code, 'token=x&password=y', 'application/x-www-form-urlencoded');

      expect(extra.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: { fields: [{ path: 'email', code: 'unknown-field' }] },
      });
      expect(bodyOf(missing).details).toEqual({ fields: [{ path: 'password', code: 'required' }] });
      expect(form.status).toBe(415);
    });

    it('"send it again" answers 202 with one body for a known and an unknown address', async () => {
      await boot();
      seedUnverified(code);

      const known = await resend(code, { email: EMAIL });
      const unknown = await resend(code, { email: 'nobody@example.com' });

      expect([known.status, unknown.status]).toEqual([202, 202]);
      expect(known.body).toEqual({ code: 'verification-resend.accepted' });
      expect(unknown.body).toEqual(known.body);
      expect(fakes.events.map((e) => e.type)).toEqual(['identity.one-time-link-requested.v1']);
      // The earlier link stopped working (3.7).
      expect([...fakes.links.values()][0]).toMatchObject({ tokenHash: null });
    });

    it('"send it again" refuses a malformed address', async () => {
      await boot();

      const response = await resend(code, { email: 'not-an-email' });

      expect(response.status).toBe(400);
      expect(bodyOf(response).details).toEqual({ fields: [{ path: 'email', code: 'format' }] });
    });
  });
});
