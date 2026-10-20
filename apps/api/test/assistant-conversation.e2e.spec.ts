import type { NestExpressApplication } from '@nestjs/platform-express';
import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { SendGuestMessage } from '../src/modules/assistant/application/use-cases/send-guest-message.use-case';
import { SendMessage } from '../src/modules/assistant/application/use-cases/send-message.use-case';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The buyer assistant's conversation route over HTTP: the real guards and controller; the two use
// cases are stubs, so this proves who reaches which use case (customer from the session, guest
// from the assistant cookie, never from the body), CSRF for a customer, the closed body, the
// status of each refusal with Retry-After, the event-stream frame and the guest cookie. The use
// cases have their own spec (conversation-use-cases.spec.ts).

const START = Temporal.Instant.from('2026-10-19T21:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ACCOUNT = id<'Account'>(0xc001);
const CONVERSATION = '0199aaaa-0000-7000-8000-000000000001';
const PATH = `/assistant/conversations/${CONVERSATION}/messages`;
const TOKEN = 'a'.repeat(43);
const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

/** The frames of an event stream, as [event, data] pairs. */
function framesOf(text: string): [string, unknown][] {
  return text
    .split('\n\n')
    .filter((frame) => frame.length > 0)
    .map((frame) => {
      const [eventLine, dataLine, ...rest] = frame.split('\n');
      expect(rest).toEqual([]);
      return [eventLine!.replace(/^event: /, ''), JSON.parse(dataLine!.replace(/^data: /, ''))];
    });
}

describe.each(TEST_MARKETS)('the assistant conversation over HTTP in market %s', (code) => {
  let app: NestExpressApplication | undefined;
  let clock: FixedClock;
  let next: unknown;
  let calls: { name: string; actor: string; input: Record<string, unknown> }[];
  const http = () => request(app!.getHttpServer());
  const marketId = code as AccountState['marketId'];
  const currency = code === 'AU' ? 'AUD' : 'JPY';
  const stub = (name: string) => ({
    execute: (context: { actor: { kind: string } }, input: Record<string, unknown>) => {
      calls.push({ name, actor: context.actor.kind, input });
      return Promise.resolve(next);
    },
  });

  async function boot() {
    ({ app } = await createTestApp({
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SendMessage)
          .useValue(stub('account'))
          .overrideProvider(SendGuestMessage)
          .useValue(stub('guest')),
    }));
  }

  function customerSession() {
    fakes.seedAccount({
      id: ACCOUNT,
      marketId,
      population: 'customer',
      email: { typed: 'Shopper@Example.com', normalized: 'shopper@example.com' },
      displayName: null,
      status: 'active',
      emailVerifiedAt: START,
      existingAccountNoticeAt: null,
      signedUpAt: START,
      createdAt: START,
      version: 1,
      credential: { passwordHash: fakeHashOf('x'), changedAt: START },
    });
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      { marketId, tenantId: 'default' } as never,
      openSession({
        id: id<'Session'>(0xf201),
        marketId,
        accountId: ACCOUNT,
        population: 'customer',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-customer-${code}=${issued.token}`,
      csrf: csrfTokenFor(issued.token),
    };
  }

  const reply = (guestToken: string | null) =>
    ok({
      conversationId: CONVERSATION,
      cards: [
        {
          kind: 'product',
          offerId: id<'Offer'>(0xd001),
          productId: id<'Product'>(0xd002),
          sellerId: id<'Seller'>(0xd003),
          name: 'Dates',
          shortText: 'Medjool',
          price: money(1250n, currency),
          regularPrice: null,
          taxInclusive: true,
        },
        { kind: 'support', email: 'help@example.com' },
      ],
      sentences: ['Here are some dates.', 'Anything else?'],
      notices: ['see-cards'],
      guestToken,
    });
  const setCookies = (res: request.Response): string[] =>
    (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    calls = [];
    next = reply(null);
  });
  afterEach(async () => {
    await app?.close();
  });

  it('answers a guest over an event stream and sets the assistant cookie for a new token', async () => {
    await boot();
    next = reply(TOKEN);

    const res = await http()
      .post(PATH)
      .set({ 'x-market-id': code })
      .send({ text: 'dates?', visitor: 'visitor-0123456789' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(framesOf(res.text)).toEqual([
      ['conversation', { id: CONVERSATION }],
      [
        'card',
        {
          kind: 'product',
          offerId: id<'Offer'>(0xd001),
          productId: id<'Product'>(0xd002),
          sellerId: id<'Seller'>(0xd003),
          name: 'Dates',
          shortText: 'Medjool',
          price: { amount: '1250', currency },
          regularPrice: null,
          taxInclusive: true,
        },
      ],
      ['card', { kind: 'support', email: 'help@example.com' }],
      ['text', { text: 'Here are some dates.' }],
      ['text', { text: 'Anything else?' }],
      ['notice', { code: 'see-cards' }],
      ['done', {}],
    ]);
    expect(setCookies(res)).toEqual([
      `__Host-assistant-guest-${code}=${TOKEN}; Max-Age=2592000; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      name: 'guest',
      actor: 'anonymous',
      input: {
        conversationId: CONVERSATION,
        text: 'dates?',
        visitor: 'visitor-0123456789',
        token: null,
      },
    });
    expect(typeof calls[0]!.input['origin']).toBe('string');
  });

  it("passes the guest's own cookie of this Market, and a malformed one as not a token", async () => {
    await boot();
    const other = code === 'AU' ? 'ZZ' : 'AU';
    await http()
      .post(PATH)
      .set({ 'x-market-id': code, cookie: `__Host-assistant-guest-${code}=${TOKEN}` })
      .send({ text: 'hi' });
    await http()
      .post(PATH)
      .set({ 'x-market-id': code, cookie: `__Host-assistant-guest-${other}=${TOKEN}` })
      .send({ text: 'hi' });
    await http()
      .post(PATH)
      .set({
        'x-market-id': code,
        cookie: `__Host-assistant-guest-${code}=${TOKEN}; __Host-assistant-guest-${code}=${TOKEN}`,
      })
      .send({ text: 'hi' });

    expect(calls.map((call) => call.input['token'])).toEqual([TOKEN, null, '!']);
  });

  it('serves a signed-in customer from the session, never a guest token, with CSRF', async () => {
    await boot();
    const session = customerSession();
    const headers = {
      'x-market-id': code,
      cookie: `${session.cookie}; __Host-assistant-guest-${code}=${TOKEN}`,
    };

    const noToken = await http().post(PATH).set(headers).send({ text: 'hi' });
    const sent = await http()
      .post(PATH)
      .set({ ...headers, 'x-csrf-token': session.csrf })
      .send({ text: 'hi' });

    expect(noToken.status).toBe(403);
    expect(sent.status).toBe(200);
    expect(setCookies(sent)).toEqual([]);
    expect(calls).toEqual([
      {
        name: 'account',
        actor: 'authenticated',
        input: { conversationId: CONVERSATION, text: 'hi', visitor: undefined },
      },
    ]);
  });

  it('refuses a body with unknown fields or of another type before any use case', async () => {
    await boot();
    const extra = await http()
      .post(PATH)
      .set({ 'x-market-id': code })
      .send({ text: 'hi', accountId: ACCOUNT, marketId: 'ZZ' });
    const form = await http()
      .post(PATH)
      .set({ 'x-market-id': code, 'content-type': 'application/x-www-form-urlencoded' })
      .send('text=hi');

    expect(extra.status).toBe(400);
    expect(form.status).toBe(415);
    expect(calls).toEqual([]);
  });

  it.each([
    ['validation.failed', 400],
    ['assistant.off', 403],
    ['assistant.sign-in-required', 403],
    ['assistant.conversation-not-found', 404],
    ['assistant.conversation-full', 409],
    ['assistant.paused', 503],
    ['assistant.unavailable', 503],
  ])('answers %s as plain JSON with status %i', async (failure, status) => {
    await boot();
    next = err(
      failure === 'validation.failed'
        ? { code: failure, fields: [{ path: 'text', issue: 'too-long' }] }
        : { code: failure },
    );

    const res = await http().post(PATH).set({ 'x-market-id': code }).send({ text: 'hi' });

    expect(res.status).toBe(status);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect((res.body as { code: string }).code).toBe(failure);
    expect(setCookies(res)).toEqual([]);
  });

  it('answers a throttled message with 429 and Retry-After', async () => {
    await boot();
    next = err({ code: 'request.throttled', retryAfterSeconds: 120 });

    const res = await http().post(PATH).set({ 'x-market-id': code }).send({ text: 'hi' });

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('120');
  });
});
