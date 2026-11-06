import type { NestExpressApplication } from '@nestjs/platform-express';
import { Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { PublishedStoreImageRead } from '../src/modules/sellers/application/use-cases/published-store-image-read.use-case';
import { StoreImageReadOwn } from '../src/modules/sellers/application/use-cases/store-image-read-own.use-case';
import { StoreImageRemove } from '../src/modules/sellers/application/use-cases/store-image-remove.use-case';
import { StoreImageSave } from '../src/modules/sellers/application/use-cases/store-image-save.use-case';
import { StoreProfileClaimTerms } from '../src/modules/sellers/application/use-cases/store-profile-claim-terms.use-case';
import { StoreProfileHistory } from '../src/modules/sellers/application/use-cases/store-profile-history.use-case';
import { StoreProfileRead } from '../src/modules/sellers/application/use-cases/store-profile-read.use-case';
import { StoreProfileSave } from '../src/modules/sellers/application/use-cases/store-profile-save.use-case';
import { StoreProfileSaveAbout } from '../src/modules/sellers/application/use-cases/store-profile-save-about.use-case';
import { IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The seller's store profile over HTTP (sellers design 3.7; slice 12 part 2): the real guards, the
// real controllers and a real seller session (identity's database ports as in-memory fakes). The
// use cases are recording stubs for the mapping tests (their behaviour is in
// store-profile.use-case.spec.ts); one test keeps the real use cases to prove the wiring and the
// gate: a visitor is 401 and a seller whose file is not approved is refused. The approved path on
// PostgreSQL is in test/db/sellers-store-profile.db-spec.ts. The public image route is checked
// with a stub too: anonymous access, the headers and the identical 404.

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

const VIEW = {
  version: 2,
  about: { 'en-AU': 'Fresh bread' },
  defaultLocale: 'en-AU',
  locales: ['en-AU'],
  logo: { id: '0199dddd-0000-7000-8000-0000000000aa', width: 512, height: 512 },
  banner: null,
  lastChanged: {
    at: Temporal.Instant.from('2026-10-15T10:00:00Z'),
    byDisplayName: 'Mia T.',
    byKind: 'member',
  },
};
const LAST_CHANGED_BODY = { at: '2026-10-15T10:00:00Z', byDisplayName: 'Mia T.', byKind: 'member' };
const ANSWER = {
  ...VIEW,
  lastChanged: LAST_CHANGED_BODY,
  aboutMaxLength: 2000,
  imageMaxBytes: 4 * 1024 * 1024,
};
const IMAGE_ID = '0199dddd-0000-7000-8000-0000000000aa';

describe('the seller store profile over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const stubs = {
    read: new Stub(),
    terms: new Stub(),
    history: new Stub(),
    about: new Stub(),
    profile: new Stub(),
    image: new Stub(),
    remove: new Stub(),
    own: new Stub(),
    publicImage: new Stub(),
  };
  const http = () => request(app.getHttpServer());

  async function boot(stubbed: boolean) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) => {
        const faked = fakes.override(builder);
        return stubbed
          ? faked
              .overrideProvider(StoreProfileRead)
              .useValue(stubs.read)
              .overrideProvider(StoreProfileSave)
              .useValue(stubs.profile)
              .overrideProvider(StoreProfileClaimTerms)
              .useValue(stubs.terms)
              .overrideProvider(StoreProfileHistory)
              .useValue(stubs.history)
              .overrideProvider(StoreProfileSaveAbout)
              .useValue(stubs.about)
              .overrideProvider(StoreImageSave)
              .useValue(stubs.image)
              .overrideProvider(StoreImageRemove)
              .useValue(stubs.remove)
              .overrideProvider(StoreImageReadOwn)
              .useValue(stubs.own)
              .overrideProvider(PublishedStoreImageRead)
              .useValue(stubs.publicImage)
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
      stub.next = { ok: true, value: VIEW };
    }
    stubs.own.next = {
      ok: true,
      value: { bytes: Buffer.from('JPEGBYTES'), contentType: 'image/jpeg' },
    };
    stubs.publicImage.next = stubs.own.next;
  });
  afterEach(async () => {
    await app.close();
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const aboutBody = { expectedVersion: 2, about: { 'en-AU': 'Fresh bread' } };
    const putAbout = (headers: Record<string, string>, body: unknown) =>
      http()
        .put('/sellers/store-profile/about')
        .set(headers)
        .send(body as object);
    const putImage = (kind: string, headers: Record<string, string>, body: unknown) =>
      http()
        .put(`/sellers/store-profile/${kind}`)
        .set(headers)
        .send(body as object);

    it('reads the profile with the seller of the session, no-store, with the limits', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await http().get('/sellers/store-profile').set(session.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual(ANSWER);
      expect(stubs.read.calls[0]!.context.market.marketId).toBe(code);
      expect(stubs.read.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
    });

    describe('the whole-profile save (text and pictures as one)', () => {
      const profileBody = {
        expectedVersion: 2,
        about: { 'en-AU': 'Fresh bread' },
        logo: { data: 'AAAA' },
        banner: null,
      };
      const putProfile = (headers: Record<string, string>, body: unknown) =>
        http()
          .put('/sellers/store-profile')
          .set(headers)
          .send(body as object);

      it('passes the version, the texts and the two pictures to the use case and answers the profile', async () => {
        await boot(true);
        const session = await signedIn(code);

        const saved = await putProfile(session.headers, profileBody);

        expect(saved.status).toBe(200);
        expect(saved.body).toEqual(ANSWER);
        expect(saved.headers['cache-control']).toBe('no-store');
        expect(stubs.profile.calls).toHaveLength(1);
        expect(stubs.profile.calls[0]!.input).toEqual(profileBody);
        expect(stubs.profile.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
      });

      it('leaves a picture out of the input when the body leaves it out', async () => {
        await boot(true);
        const session = await signedIn(code);

        await putProfile(session.headers, aboutBody);

        expect(stubs.profile.calls[0]!.input).toEqual(aboutBody);
      });

      it('requires CSRF and takes a body larger than the JSON limit only with a session and the header', async () => {
        await boot(true);
        const session = await signedIn(code);
        const big = { ...profileBody, logo: { data: 'A'.repeat(200_000) } };

        const noToken = await putProfile({ ...session.headers, 'x-csrf-token': '' }, profileBody);
        const largeNoToken = await putProfile({ ...session.headers, 'x-csrf-token': '' }, big);
        const largeNoCookie = await putProfile({ ...session.headers, cookie: '' }, big);
        const large = await putProfile(session.headers, big);

        expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
        expect(largeNoToken.status).toBe(413);
        expect(largeNoCookie.status).toBe(413);
        expect(large.status).toBe(200);
        expect(stubs.profile.calls).toHaveLength(1);
      });

      it.each([
        ['a seller id', { ...profileBody, sellerId: 'x' }, 'sellerId', 'unknown-field'],
        ['no version', { about: {} }, 'expectedVersion', 'required'],
        ['no about', { expectedVersion: 1 }, 'about', 'required'],
        ['a logo that is a string', { ...profileBody, logo: 'x' }, 'logo', 'type'],
        ['a logo with no data', { ...profileBody, logo: {} }, 'logo.data', 'required'],
        ['a banner with a number', { ...profileBody, banner: { data: 5 } }, 'banner.data', 'type'],
        [
          'an extra field on a picture',
          { ...profileBody, logo: { data: 'AAAA', kind: 'x' } },
          'logo.kind',
          'unknown-field',
        ],
        ['an array body', [], '', 'type'],
      ])(
        'refuses %s as validation.failed without calling the use case',
        async (_n, body, path, fieldCode) => {
          await boot(true);
          const session = await signedIn(code);

          const response = await putProfile(session.headers, body);

          expect(response.status).toBe(400);
          expect(response.body).toMatchObject({
            code: 'validation.failed',
            details: { fields: expect.arrayContaining([{ path, code: fieldCode }]) as unknown },
          });
          expect(stubs.profile.calls).toHaveLength(0);
        },
      );

      it('refuses a body that is not JSON with 415', async () => {
        await boot(true);
        const session = await signedIn(code);

        const response = await http()
          .put('/sellers/store-profile')
          .set(session.headers)
          .set('content-type', 'text/plain')
          .send('x');

        expect(response.status).toBe(415);
        expect(stubs.profile.calls).toHaveLength(0);
      });

      it.each([
        ['conflict.stale', 409, undefined],
        ['access.denied', 403, undefined],
        ['file.not-found', 404, undefined],
        ['sellers.unavailable', 503, undefined],
        ['file.too-large', 413, 'logo'],
        ['file.unsupported-type', 415, 'logo'],
        ['file.too-many-pixels', 422, 'banner'],
        ['file.too-small', 422, 'banner'],
        ['file.unreadable', 422, 'logo'],
      ])('maps %s to %i, naming the picture (%s)', async (errorCode, status, kind) => {
        await boot(true);
        const session = await signedIn(code);
        stubs.profile.next = {
          ok: false,
          error: kind === undefined ? { code: errorCode } : { code: errorCode, kind },
        };

        const response = await putProfile(session.headers, profileBody);

        expect(response.status).toBe(status);
        expect((response.body as { code: string }).code).toBe(errorCode);
        if (kind !== undefined) expect(response.body).toMatchObject({ details: { kind } });
      });

      it('answers the claim wording as validation.failed with the about field, and a throttled save with 429', async () => {
        await boot(true);
        const session = await signedIn(code);
        stubs.profile.next = {
          ok: false,
          error: {
            code: 'validation.failed',
            fields: [{ path: 'about.en-AU', code: 'claim-term' }],
          },
        };
        const refused = await putProfile(session.headers, profileBody);
        stubs.profile.next = {
          ok: false,
          error: { code: 'request.throttled', retryAfterSeconds: 7 },
        };
        const throttled = await putProfile(session.headers, profileBody);

        expect(refused.status).toBe(400);
        expect(refused.body).toMatchObject({
          details: { fields: [{ path: 'about.en-AU', code: 'claim-term' }] },
        });
        expect(throttled.status).toBe(429);
        expect(throttled.headers['retry-after']).toBe('7');
      });
    });

    it('reads the claim terms with the seller of the session, no-store, as a list', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.terms.next = { ok: true, value: ['halal', 'halal certified'] };

      const response = await http().get('/sellers/store-profile/claim-terms').set(session.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ terms: ['halal', 'halal certified'] });
      expect(stubs.terms.calls[0]!.context.market.marketId).toBe(code);
      expect(stubs.terms.calls[0]!.context.actor).toMatchObject({ population: 'seller' });
    });

    it('answers the claim terms as 503 when they cannot be read, never an empty list', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.terms.next = { ok: false, error: { code: 'sellers.unavailable' } };

      const response = await http().get('/sellers/store-profile/claim-terms').set(session.headers);

      expect(response.status).toBe(503);
    });

    it('lists the changes of the page: paging passed on, names only, no cache', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.history.next = {
        ok: true,
        value: {
          items: [
            {
              id: 'row-1',
              at: Temporal.Instant.from('2026-10-15T10:00:00Z'),
              byDisplayName: 'Mia T.',
              byKind: 'member',
              fields: ['about'],
            },
          ],
          next: null,
        },
      };

      const response = await http()
        .get('/sellers/store-profile/history?limit=5&after=abc')
        .set(session.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({
        items: [{ id: 'row-1', ...LAST_CHANGED_BODY, fields: ['about'] }],
        next: null,
      });
      expect(stubs.history.calls[0]!.input).toEqual({ after: 'abc', limit: 5 });
      expect(stubs.history.calls[0]!.context.actor).toMatchObject({ population: 'seller' });

      stubs.history.next = { ok: false, error: { code: 'access.denied' } };
      expect((await http().get('/sellers/store-profile/history').set(session.headers)).status).toBe(
        403,
      );
    });

    it('answers a stale save with 409 conflict.stale naming who saved first and when', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.about.next = {
        ok: false,
        error: { code: 'conflict.stale', lastChanged: VIEW.lastChanged },
      };

      const response = await putAbout(session.headers, aboutBody);

      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        code: 'conflict.stale',
        details: { lastChanged: LAST_CHANGED_BODY },
      });
    });

    it('saves the About text: only the two named fields, CSRF required, no-store', async () => {
      await boot(true);
      const session = await signedIn(code);

      const noToken = await putAbout({ ...session.headers, 'x-csrf-token': '' }, aboutBody);
      const saved = await putAbout(session.headers, aboutBody);

      expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual(ANSWER);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(stubs.about.calls).toHaveLength(1);
      expect(stubs.about.calls[0]!.input).toEqual(aboutBody);
    });

    it.each([
      ['a seller id', { ...aboutBody, sellerId: 'x' }, 'sellerId', 'unknown-field'],
      ['no version', { about: {} }, 'expectedVersion', 'required'],
      ['no about', { expectedVersion: 1 }, 'about', 'required'],
      ['a string version', { ...aboutBody, expectedVersion: '2' }, 'expectedVersion', 'type'],
      ['about as a string', { expectedVersion: 1, about: 'text' }, 'about', 'type'],
      ['a text that is a number', { expectedVersion: 1, about: { 'en-AU': 5 } }, 'about', 'type'],
      ['an array body', [], '', 'type'],
    ])(
      'refuses %s on About as validation.failed without calling the use case',
      async (_n, body, path, fieldCode) => {
        await boot(true);
        const session = await signedIn(code);

        const response = await putAbout(session.headers, body);

        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: expect.arrayContaining([{ path, code: fieldCode }]) as unknown },
        });
        expect(stubs.about.calls).toHaveLength(0);
      },
    );

    it('refuses an About body that is not JSON with 415', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await http()
        .put('/sellers/store-profile/about')
        .set(session.headers)
        .set('content-type', 'text/plain')
        .send('expectedVersion=1');

      expect(response.status).toBe(415);
      expect(stubs.about.calls).toHaveLength(0);
    });

    it.each([
      ['conflict.stale', 409, 'about'],
      ['validation.failed', 400, 'about'],
      ['file.not-found', 404, 'about'],
      ['access.denied', 403, 'about'],
      ['sellers.unavailable', 503, 'about'],
      ['access.unavailable', 503, 'about'],
      ['file.too-large', 413, 'logo'],
      ['file.unsupported-type', 415, 'logo'],
      ['file.too-many-pixels', 422, 'banner'],
      ['file.too-small', 422, 'banner'],
      ['file.unreadable', 422, 'logo'],
      ['conflict.stale', 409, 'logo'],
    ])('maps %s to %i on %s', async (errorCode, status, route) => {
      await boot(true);
      const session = await signedIn(code);
      const stub = route === 'about' ? stubs.about : stubs.image;
      stub.next = {
        ok: false,
        error:
          errorCode === 'validation.failed'
            ? { code: errorCode, fields: [{ path: 'about.en-AU', code: 'claim-term' }] }
            : { code: errorCode },
      };

      const response =
        route === 'about'
          ? await putAbout(session.headers, aboutBody)
          : await putImage(route, session.headers, { data: 'AAAA' });

      expect(response.status).toBe(status);
      expect((response.body as { code: string }).code).toBe(errorCode);
      if (errorCode === 'validation.failed') {
        expect(response.body).toMatchObject({
          details: { fields: [{ path: 'about.en-AU', code: 'claim-term' }] },
        });
      }
    });

    it('answers a throttled save with 429 and Retry-After', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.about.next = { ok: false, error: { code: 'request.throttled', retryAfterSeconds: 7 } };

      const response = await putAbout(session.headers, aboutBody);

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('7');
      expect(response.body).toMatchObject({ details: { retryAfterSeconds: 7 } });
    });

    it.each(['logo', 'banner'])(
      'sets the %s from a base64 body larger than the JSON limit',
      async (kind) => {
        await boot(true);
        const session = await signedIn(code);
        const data = 'A'.repeat(200_000); // 200 KB: over the 64 KB JSON limit, under the image one

        const saved = await putImage(kind, session.headers, { data });
        // Without the CSRF header the large body is not even read: the 64 KiB parser refuses it.
        const noToken = await putImage(kind, { ...session.headers, 'x-csrf-token': '' }, { data });
        // A small body without the header reaches the guard, which refuses the token.
        const noTokenSmall = await putImage(
          kind,
          { ...session.headers, 'x-csrf-token': '' },
          { data: 'AAAA' },
        );

        expect(saved.status).toBe(200);
        expect(saved.body).toEqual(ANSWER);
        expect(saved.headers['cache-control']).toBe('no-store');
        expect(noToken.status).toBe(413);
        expect(noTokenSmall.status).toBe(403);
        expect(stubs.image.calls).toHaveLength(1);
        expect(stubs.image.calls[0]!.input).toEqual({ kind, data });
      },
    );

    it.each([
      ['no session cookie', (h: Record<string, string>) => ({ ...h, cookie: '' })],
      ['no CSRF header', (h: Record<string, string>) => ({ ...h, 'x-csrf-token': '' })],
    ])(
      'keeps the 64 KiB limit on an image PUT with %s, before any use case (Hassan H4)',
      async (_n, strip) => {
        await boot(true);
        const session = await signedIn(code);

        const response = await putImage('logo', strip(session.headers), {
          data: 'A'.repeat(200_000),
        });

        expect(response.status).toBe(413);
        expect(stubs.image.calls).toHaveLength(0);
      },
    );

    it('refuses an image body over the image limit with 413 before any use case', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await putImage('logo', session.headers, { data: 'A'.repeat(6_000_000) });

      expect(response.status).toBe(413);
      expect(stubs.image.calls).toHaveLength(0);
    });

    it.each([
      ['a kind in the body', { data: 'AAAA', kind: 'banner' }, 'kind', 'unknown-field'],
      // The picture routes are last-write-wins: they carry no version, so one is refused, not
      // ignored (only the About text is guarded by expectedVersion).
      [
        'an expectedVersion (the picture routes are last-write-wins)',
        { data: 'AAAA', expectedVersion: 2 },
        'expectedVersion',
        'unknown-field',
      ],
      ['no data', {}, 'data', 'required'],
      ['data that is a number', { data: 12 }, 'data', 'type'],
    ])('refuses %s on the logo as validation.failed', async (_n, body, path, fieldCode) => {
      await boot(true);
      const session = await signedIn(code);

      const response = await putImage('logo', session.headers, body);

      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: expect.arrayContaining([{ path, code: fieldCode }]) as unknown },
      });
      expect(stubs.image.calls).toHaveLength(0);
    });

    it('answers 503 access.unavailable with Retry-After when the picture pipeline is busy (Hassan H2)', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.image.next = {
        ok: false,
        error: { code: 'access.unavailable', retryAfterSeconds: 2 },
      };

      const response = await putImage('logo', session.headers, { data: 'AAAA' });

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('2');
      expect(response.body).toEqual({ statusCode: 503, code: 'access.unavailable' });
    });

    it('hands the own-image route an unknown size and an id that is not an id to the use case unchanged', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.own.next = { ok: false, error: { code: 'image.not-found' } };

      const huge = await http()
        .get(`/sellers/store-profile/images/${IMAGE_ID}/huge`)
        .set(session.headers);
      const notAnId = await http()
        .get('/sellers/store-profile/images/not-an-id/small')
        .set(session.headers);

      expect(huge.status).toBe(404);
      expect(notAnId.status).toBe(404);
      expect(notAnId.body).toEqual(huge.body);
      expect(stubs.own.calls.map((call) => call.input)).toEqual([
        { imageId: IMAGE_ID, size: 'huge' },
        { imageId: 'not-an-id', size: 'small' },
      ]);
    });

    it('refuses an image body that is not JSON with 415', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await http()
        .put('/sellers/store-profile/banner')
        .set(session.headers)
        .set('content-type', 'image/png')
        .send(Buffer.from('not json'));

      expect(response.status).toBe(415);
      expect(stubs.image.calls).toHaveLength(0);
    });

    it.each(['logo', 'banner'])(
      'removes the %s: CSRF required, the kind comes from the route',
      async (kind) => {
        await boot(true);
        const session = await signedIn(code);

        const noToken = await http()
          .delete(`/sellers/store-profile/${kind}`)
          .set({ ...session.headers, 'x-csrf-token': '' });
        const removed = await http().delete(`/sellers/store-profile/${kind}`).set(session.headers);

        expect(noToken.status).toBe(403);
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual(ANSWER);
        expect(removed.headers['cache-control']).toBe('no-store');
        expect(stubs.remove.calls).toHaveLength(1);
        expect(stubs.remove.calls[0]!.input).toEqual({ kind });
      },
    );

    it('serves the seller their own image bytes, private, nosniff, with a CSP that allows nothing', async () => {
      await boot(true);
      const session = await signedIn(code);

      const response = await http()
        .get(`/sellers/store-profile/images/${IMAGE_ID}/small`)
        .set(session.headers)
        .buffer(true);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['content-security-policy']).toContain("default-src 'none'");
      expect((response.body as Buffer).toString()).toBe('JPEGBYTES');
      expect(stubs.own.calls[0]!.input).toEqual({ imageId: IMAGE_ID, size: 'small' });
    });

    it("answers image.not-found with 404 for an image that is not the seller's current one", async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.own.next = { ok: false, error: { code: 'image.not-found' } };

      const response = await http()
        .get(`/sellers/store-profile/images/${IMAGE_ID}/large`)
        .set(session.headers);

      expect(response.status).toBe(404);
      expect(response.body).toEqual({ statusCode: 404, code: 'image.not-found' });
    });

    it('refuses a visitor with 401 on every route; the gate holds back a pending seller (real use cases)', async () => {
      await boot(false);
      const session = await signedIn(code);
      const visitor = { 'x-market-id': code, ...panelHeaders(code, 'seller') };
      const own = session.headers;

      const visitors = [
        await http().get('/sellers/store-profile').set(visitor),
        await putAbout(visitor, aboutBody),
        await http().put('/sellers/store-profile').set(visitor).send(aboutBody),
        await putImage('logo', visitor, { data: 'AAAA' }),
        await http().delete('/sellers/store-profile/banner').set(visitor),
        await http().get(`/sellers/store-profile/images/${IMAGE_ID}/small`).set(visitor),
      ];
      const sellers = [
        await http().get('/sellers/store-profile').set(own),
        await putAbout(own, aboutBody),
        await http().put('/sellers/store-profile').set(own).send(aboutBody),
        await putImage('banner', own, { data: 'AAAA' }),
        await http().delete('/sellers/store-profile/logo').set(own),
        await http().get(`/sellers/store-profile/images/${IMAGE_ID}/small`).set(own),
      ];

      for (const answer of visitors) expect(answer.status).toBe(401);
      // AU requires approval, so a just-registered seller is pending and the gate refuses it
      // (403) before the use case reads anything.
      // ZZ approves at once, so the gate admits the seller and the use case runs. This suite has no
      // database for sellers' repositories, so the run fails closed with the exact answer below
      // (503, the code of the step that could not read); the admitted path is proved on PostgreSQL
      // in test/db/sellers-store-profile-http.db-spec.ts.
      const ZZ_UNAVAILABLE = [
        'sellers.unavailable',
        'access.unavailable',
        'access.unavailable',
        'access.unavailable',
        'access.unavailable',
        'sellers.unavailable',
      ];
      sellers.forEach((answer, index) => {
        if (code === 'AU') {
          expect(answer.status).toBe(403);
        } else {
          expect(answer.status).toBe(503);
          expect((answer.body as { code: string }).code).toBe(ZZ_UNAVAILABLE[index]);
        }
      });
    });

    describe('the public image route', () => {
      const get = (path: string, headers: Record<string, string> = {}) =>
        http()
          .get(path)
          .set({ 'x-market-id': code, ...headers })
          .buffer(true);

      it('serves the bytes to a visitor with no session: cacheable, nosniff, nothing allowed by CSP', async () => {
        await boot(true);

        const response = await get(`/sellers/stores/kedron-halal/images/${IMAGE_ID}/large`, {
          cookie: `__Host-session-customer-${code}=whatever`,
        });

        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toBe('image/jpeg');
        expect(response.headers['cache-control']).toBe('public, max-age=300');
        expect(response.headers['x-content-type-options']).toBe('nosniff');
        expect(response.headers['content-security-policy']).toContain("default-src 'none'");
        expect(response.headers['set-cookie']).toBeUndefined();
        expect((response.body as Buffer).toString()).toBe('JPEGBYTES');
        expect(stubs.publicImage.calls[0]!.input).toEqual({
          slug: 'kedron-halal',
          imageId: IMAGE_ID,
          size: 'large',
        });
        expect(stubs.publicImage.calls[0]!.context.actor).toMatchObject({ kind: 'anonymous' });
        expect(stubs.publicImage.calls[0]!.context.market.marketId).toBe(code);
      });

      it('answers one identical 404, not cacheable, for every case the use case calls not found', async () => {
        await boot(true);
        stubs.publicImage.next = { ok: false, error: { code: 'image.not-found' } };

        const answers = [
          await get(`/sellers/stores/kedron-halal/images/${IMAGE_ID}/large`),
          await get(`/sellers/stores/no-such-store/images/${IMAGE_ID}/small`),
          await get('/sellers/stores/kedron-halal/images/not-an-id/small'),
        ];

        for (const answer of answers) {
          expect(answer.status).toBe(404);
          expect(answer.headers['cache-control']).toBe('no-store');
          expect(answer.body).toEqual({ statusCode: 404, code: 'image.not-found' });
        }
      });

      it('answers 503 sellers.unavailable when the store reads fail', async () => {
        await boot(true);
        stubs.publicImage.next = { ok: false, error: { code: 'sellers.unavailable' } };

        const response = await get(`/sellers/stores/kedron-halal/images/${IMAGE_ID}/large`);

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'sellers.unavailable' });
      });
    });
  });
});
