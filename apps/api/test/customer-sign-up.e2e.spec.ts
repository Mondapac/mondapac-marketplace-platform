import type { NestExpressApplication } from '@nestjs/platform-express';
import type { TestingModuleBuilder } from '@nestjs/testing';
import { err, ok } from '@mondapac/shared-kernel';
import type { MarketContext, PendingEvent, Result } from '@mondapac/shared-kernel';
import request from 'supertest';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../src/modules/identity/application/ports/account.repository';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
  type PasswordHasherBusy,
} from '../src/modules/identity/application/ports/password-hasher';
import { Account, type AccountState } from '../src/modules/identity/domain/account';
import { OUTBOX_WRITER, type OutboxWriter } from '../src/platform/events/outbox-writer';
import { UNIT_OF_WORK, type UnitOfWork } from '../src/platform/unit-of-work/unit-of-work';
import { createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// Customer sign-up over HTTP (identity design 5.2, 6.4, 6.7, 6.8; slice 1d). The database
// ports are in-memory fakes (no database in `pnpm test`); the end-to-end run against
// PostgreSQL is test/db/customer-sign-up.db-spec.ts. A fresh application per test: the rate
// limiter's counters live in its memory. nestjs-pino captures the log lines of the first
// application of a file only, so the logging test comes first.

const PATH = '/identity/customer/sign-up';
const PASSWORD = 'correct horse battery staple';

const state = {
  accounts: new Map<string, AccountState>(),
  events: [] as PendingEvent[],
  hashed: 0,
  busy: false,
};

const fakeUnitOfWork: UnitOfWork = {
  run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
};
const fakeAccounts: AccountRepository = {
  findByEmail: (market, population, email) => {
    const stored = state.accounts.get(`${market.marketId}|${population}|${email}`);
    return Promise.resolve(stored === undefined ? null : Account.restore(stored));
  },
  add: (market, account) => {
    const { population, email } = account.state;
    state.accounts.set(`${market.marketId}|${population}|${email.normalized}`, account.state);
    return Promise.resolve(ok(undefined));
  },
  save: () => Promise.resolve(),
};
const fakeOutbox: OutboxWriter = {
  append: (_context, events) => {
    state.events.push(...events);
    return Promise.resolve();
  },
};
const fakeHasher: PasswordHasher = {
  hash: (): Promise<Result<string, PasswordHasherBusy>> => {
    if (state.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
    state.hashed += 1;
    return Promise.resolve(ok(`$argon2id$v=19$fake-${state.hashed}`));
  },
  verify: () => Promise.reject(new Error('sign-up never verifies')),
};

const override = (builder: TestingModuleBuilder) =>
  builder
    .overrideProvider(UNIT_OF_WORK)
    .useValue(fakeUnitOfWork)
    .overrideProvider(ACCOUNT_REPOSITORY)
    .useValue(fakeAccounts)
    .overrideProvider(OUTBOX_WRITER)
    .useValue(fakeOutbox)
    .overrideProvider(PASSWORD_HASHER)
    .useValue(fakeHasher);

describe('POST /identity/customer/sign-up (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const signUp = (market: string, body: unknown, headers: Record<string, string> = {}) =>
    request(app.getHttpServer())
      .post(PATH)
      .set({ 'x-market-id': market, ...headers })
      .send(body as object);

  async function boot(env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({ env: { LOG_LEVEL: 'info', ...env }, override }));
  }

  beforeEach(() => {
    state.accounts.clear();
    state.events.length = 0;
    state.hashed = 0;
    state.busy = false;
  });

  afterEach(async () => {
    await app.close();
  });

  it('logs the outcome with the correlation id, never the email or the password', async () => {
    await boot();

    const response = await signUp('AU', { email: 'logged@example.com', password: PASSWORD });

    expect(response.status).toBe(202);
    const correlationId = response.headers['x-correlation-id'] as string;
    const line = logLines.find((l) => l.msg === 'identity.customer-sign-up');
    expect(line).toMatchObject({ outcome: 'sign-up.accepted', marketId: 'AU' });
    expect(correlationId).toEqual(expect.any(String));
    expect(line?.correlationId).toBe(correlationId);
    const all = JSON.stringify(logLines);
    expect(all).not.toContain('logged@example.com');
    expect(all).not.toContain(PASSWORD);
  });

  it.each(TEST_MARKETS)(
    'accepts a customer sign-up without a name in %s: 202, one answer',
    async (code) => {
      await boot();

      const first = await signUp(code, { email: 'new@example.com', password: PASSWORD });
      const again = await signUp(code, { email: 'NEW@example.com', password: `${PASSWORD}!` });

      expect([first.status, again.status]).toEqual([202, 202]);
      expect(first.body).toEqual({ code: 'sign-up.accepted' });
      expect(again.body).toEqual(first.body);
      expect(first.headers['cache-control']).toBe('no-store');
      const [account] = [...state.accounts.values()];
      expect(account).toMatchObject({ marketId: code, displayName: null });
      expect(state.events.map((e) => e.type)).toEqual([
        'identity.customer-account-registered.v1',
        'identity.sign-up-repeated.v1',
      ]);
      expect(state.hashed).toBe(2);
    },
  );

  it.each(TEST_MARKETS)('refuses a password equal to the email in %s', async (code) => {
    await boot();
    const email = 'longer.address@example.com';

    const response = await signUp(code, { email, password: email });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'password.rejected',
      details: { rule: 'contains-identity' },
    });
    expect(state.hashed).toBe(0);
  });

  it('refuses an unknown field and stores nothing (a customer gives no name)', async () => {
    await boot();

    const response = await signUp('AU', {
      email: 'a@example.com',
      password: PASSWORD,
      displayName: 'Ali',
    });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'displayName', code: 'unknown-field' }] },
    });
    expect(state.accounts.size).toBe(0);
  });

  it('names missing and mistyped fields without echoing a value', async () => {
    await boot();

    const missing = await signUp('ZZ', {});
    const mistyped = await signUp('ZZ', { email: ['a@example.com'], password: 12345 });
    const malformed = await signUp('ZZ', { email: 'not an email', password: PASSWORD });
    const array = await signUp('ZZ', [PASSWORD]);

    expect(missing.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: {
        fields: [
          { path: 'email', code: 'required' },
          { path: 'password', code: 'required' },
        ],
      },
    });
    expect(mistyped.body).toMatchObject({
      details: {
        fields: [
          { path: 'email', code: 'type' },
          { path: 'password', code: 'type' },
        ],
      },
    });
    expect(malformed.body).toEqual({
      statusCode: 400,
      code: 'validation.failed',
      details: { fields: [{ path: 'email', code: 'format' }] },
    });
    expect(array.body).toMatchObject({ code: 'validation.failed' });
    expect(JSON.stringify([missing.body, mistyped.body, malformed.body])).not.toContain('12345');
  });

  it('answers 415 to a body that is not JSON', async () => {
    await boot();

    const response = await request(app.getHttpServer())
      .post(PATH)
      .set('x-market-id', 'AU')
      .type('form')
      .send(`email=a%40example.com&password=${encodeURIComponent(PASSWORD)}`);

    expect(response.status).toBe(415);
    expect(response.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
    expect(state.hashed).toBe(0);
  });

  it('answers 503 request.busy with Retry-After when the hash queue is full', async () => {
    await boot();
    state.busy = true;

    const response = await signUp('AU', { email: 'a@example.com', password: PASSWORD });

    expect(response.status).toBe(503);
    expect(response.body).toEqual({
      statusCode: 503,
      code: 'request.busy',
      details: { retryAfterSeconds: 1 },
    });
    expect(response.headers['retry-after']).toBe('1');
  });

  it('refuses a request without x-market-id before the rate limiter or the use case', async () => {
    await boot();

    const response = await request(app.getHttpServer())
      .post(PATH)
      .send({ email: 'a@example.com', password: PASSWORD });

    expect(response.status).toBe(400);
    expect(state.hashed).toBe(0);
  });

  it("throttles at the Market's anonymous identity limit before the use case runs", async () => {
    await boot();
    for (let index = 0; index < 10; index += 1) {
      await signUp('ZZ', { email: `u${index}@example.com`, password: PASSWORD }).expect(202);
    }

    const refused = await signUp('ZZ', { email: 'late@example.com', password: PASSWORD });

    expect(refused.status).toBe(429);
    expect(refused.body).toEqual({
      statusCode: 429,
      code: 'request.throttled',
      details: { retryAfterSeconds: expect.any(Number) as number },
    });
    const { retryAfterSeconds } = (refused.body as { details: { retryAfterSeconds: number } })
      .details;
    expect(retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(refused.headers['retry-after']).toBe(String(retryAfterSeconds));
    expect(state.hashed).toBe(10);
  });

  it('refuses a Market this stack does not host before the use case runs', async () => {
    await boot();

    const response = await signUp('NZ', { email: 'a@example.com', password: PASSWORD });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ statusCode: 400, code: 'market.not-hosted' });
    expect(state.hashed).toBe(0);
  });

  // Sajad G1: the length boundaries of each Market over HTTP (AU 15..128, ZZ 16..100), and the
  // 1024-byte bound of the raw input. The passwords are slices of a passphrase, so none is on
  // the common list.
  describe.each([
    { code: 'AU', min: 15, max: 128 },
    { code: 'ZZ', min: 16, max: 100 },
  ])('password length boundaries in $code', ({ code, min, max }) => {
    const ofLength = (length: number) =>
      'lantern harbour biscuit quietly folding maps '.repeat(30).slice(0, length);
    const LENGTH_REFUSED = {
      statusCode: 400,
      code: 'password.rejected',
      details: { rule: 'length' },
    };

    it.each([14, 15, 16, 100, 101, 128, 129])('%i characters', async (length) => {
      await boot();

      const response = await signUp(code, { email: 'len@example.com', password: ofLength(length) });

      if (length >= min && length <= max) {
        expect(response.status).toBe(202);
        expect(state.hashed).toBe(1);
      } else {
        expect(response.status).toBe(400);
        expect(response.body).toEqual(LENGTH_REFUSED);
        expect(state.hashed).toBe(0);
      }
    });

    it('more than 1024 bytes', async () => {
      await boot();

      const response = await signUp(code, { email: 'len@example.com', password: 'a'.repeat(1025) });

      expect(response.status).toBe(400);
      expect(response.body).toEqual(LENGTH_REFUSED);
      expect(state.hashed).toBe(0);
    });
  });

  it('is in the OpenAPI document with the x-market-id header and its answers', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });

    const response = await request(app.getHttpServer()).get('/docs-json').expect(200);

    const operation = (
      response.body as {
        paths: Record<
          string,
          {
            post?: {
              parameters?: { name: string; in: string; required?: boolean }[];
              responses: Record<string, unknown>;
              requestBody?: unknown;
            };
          }
        >;
      }
    ).paths[PATH]?.post;
    expect(operation?.parameters).toContainEqual(
      expect.objectContaining({ name: 'x-market-id', in: 'header', required: true }),
    );
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '202',
      '400',
      '415',
      '429',
      '503',
    ]);
    expect(operation?.requestBody).toBeDefined();
  });
});
