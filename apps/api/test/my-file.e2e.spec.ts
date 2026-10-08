import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { SeedSystemRoles } from '../src/modules/identity/application/use-cases/seed-system-roles.use-case';
import { SendLinkMail } from '../src/modules/identity/application/use-cases/send-link-mail.use-case';
import { FormDescriptorsRead } from '../src/modules/sellers/application/use-cases/form-descriptors-read.use-case';
import { MyFileCheckSlug } from '../src/modules/sellers/application/use-cases/my-file-check-slug.use-case';
import { MyFileRead } from '../src/modules/sellers/application/use-cases/my-file-read.use-case';
import { MyFileSaveAddress } from '../src/modules/sellers/application/use-cases/my-file-save-address.use-case';
import { MyFileSaveSlug } from '../src/modules/sellers/application/use-cases/my-file-save-slug.use-case';
import { MyFileSaveGeneral } from '../src/modules/sellers/application/use-cases/my-file-save-general.use-case';
import { IdentityFakes } from './support/identity-fakes';
import { completionLineOf, createTestApp, type LogLine } from './support/test-app';
import { TEST_MARKETS } from './support/test-config';

// The seller's draft routes over HTTP (sellers design 6.2, 8.3; slice 2): the real guards, the
// real controller and a real seller session (identity's database ports as in-memory fakes). The
// five use cases are replaced by recording stubs for the mapping tests: their own behaviour is
// covered by their specs. Two tests keep the real use cases to prove the wiring and the gate:
// until identity slice 8a no seller holds `sellers.business-identity.edit`, so every route
// answers access.denied to a signed-in seller and access.unauthenticated to a visitor.
// nestjs-pino captures the log lines of a file's first application only, so the logging test
// comes first.

const PASSWORD = 'correct horse battery staple';
const EMAIL = 'Owner@Example.com';
const NAME = 'Amina Rahman';
const CANARY = 'CANARY-PHONE-0412345678';
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

const detailsOf = (response: { body: unknown }): unknown =>
  (response.body as { details?: unknown }).details;

const SAVED = {
  version: 2,
  draftComplete: false,
  missing: ['address', 'timezone', 'slug'],
};

describe('the seller draft over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  const stubs = {
    read: new Stub(),
    general: new Stub(),
    address: new Stub(),
    slug: new Stub(),
    saveSlug: new Stub(),
    descriptors: new Stub(),
  };
  const http = () => request(app.getHttpServer());

  async function boot(stubbed: boolean, env: Record<string, string> = {}) {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      override: (builder) => {
        const faked = fakes.override(builder);
        return stubbed
          ? faked
              .overrideProvider(MyFileRead)
              .useValue(stubs.read)
              .overrideProvider(MyFileSaveGeneral)
              .useValue(stubs.general)
              .overrideProvider(MyFileSaveAddress)
              .useValue(stubs.address)
              .overrideProvider(MyFileSaveSlug)
              .useValue(stubs.saveSlug)
              .overrideProvider(MyFileCheckSlug)
              .useValue(stubs.slug)
              .overrideProvider(FormDescriptorsRead)
              .useValue(stubs.descriptors)
          : faked;
      },
    }));
  }

  const systemOf = (code: string) =>
    testCallContext(testMarketContext(code, PLATFORM_TENANT_ID), 'system', 'my-file-e2e-0001');

  /** Signs a seller up, confirms the email, and answers the session cookie and CSRF token. */
  async function signedIn(code: string) {
    await app.get(SeedSystemRoles).execute(systemOf(code), {});
    const headers = { 'x-market-id': code };
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
        'x-market-id': code,
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

  it('logs the outcome with the correlation id and never a request body', async () => {
    await boot(true);
    const session = await signedIn('AU');
    stubs.general.next = { ok: true, value: SAVED };

    const saved = await http()
      .put('/sellers/my-file/general')
      .set(session.headers)
      .send({ phone: CANARY, businessName: 'Secret Pty Ltd' });

    expect(saved.status).toBe(200);
    expect(logLines.find((l) => l.msg === 'sellers.my-file-save-general')).toMatchObject({
      outcome: 'saved',
      marketId: 'AU',
      correlationId: saved.headers['x-correlation-id'] as string,
    });
    const completion = completionLineOf(logLines, saved.headers['x-correlation-id'] as string);
    expect(JSON.stringify(completion)).not.toContain(CANARY);
    const all = JSON.stringify(logLines);
    expect(all).not.toContain(CANARY);
    expect(all).not.toContain('Secret Pty Ltd');
  });

  it('never puts a canary in a response or a log line, on the failure paths and the other routes', async () => {
    await boot(true);
    const session = await signedIn('AU');
    const canaryKey = `${CANARY}-KEY`;
    const responses: { body: unknown; text: string }[] = [];
    const keep = (r: { body: unknown; text: string }) => responses.push(r);

    stubs.general.next = { ok: false, error: { code: 'request.throttled', retryAfterSeconds: 5 } };
    stubs.slug.next = { ok: true, value: { code: 'slug.available', slug: 'x' } };
    stubs.address.next = { ok: true, value: SAVED };
    const put = (path: string) => http().put(path).set(session.headers);
    keep(await put('/sellers/my-file/general').send({ [canaryKey]: CANARY }));
    keep(
      await put('/sellers/my-file/general')
        .set('content-type', 'application/json')
        .send(`{"phone": "${CANARY}"`),
    );
    keep(
      await put('/sellers/my-file/general')
        .set('content-type', 'text/plain')
        .send(`phone=${CANARY}`),
    );
    keep(await put('/sellers/my-file/general').send({ phone: CANARY }));
    keep(await put('/sellers/my-file/address').send({ address: { [canaryKey]: 1 } }));
    keep(await put('/sellers/my-file/address').send({ address: { line1: CANARY } }));
    keep(
      await http()
        .post('/sellers/my-file/slug-check')
        .set(session.headers)
        .send({ slug: CANARY, [canaryKey]: CANARY }),
    );

    expect(responses.every((r) => r.text.length > 0)).toBe(true);
    // A top-level unknown field name is echoed to its own sender by design (bounded, sanitised,
    // design 8.3); a nested address key and every value never are, and no log line holds any.
    const echoed = responses.map((r) => r.text).join('\n');
    expect(echoed).not.toContain(`${CANARY}"`);
    expect(echoed).not.toContain('address.CANARY');
    expect(echoed.replaceAll(canaryKey, '')).not.toContain('CANARY-PHONE');
    expect(JSON.stringify(logLines)).not.toContain('CANARY-PHONE');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('refuses a visitor and a signed-in seller without the permission (real use cases, real gate)', async () => {
      await boot(false);
      const session = await signedIn(code);

      // A well-shaped body per route: the shape is checked before the gate, so a malformed body
      // would answer 400 to anyone who is signed in.
      for (const [method, path, body] of [
        ['get', '/sellers/my-file', {}],
        ['get', '/sellers/my-file/form-descriptors', {}],
        ['put', '/sellers/my-file/general', { phone: '0400' }],
        ['put', '/sellers/my-file/address', { address: { line1: 'x' } }],
        ['put', '/sellers/my-file/slug', { slug: 'a-shop' }],
        ['post', '/sellers/my-file/slug-check', { slug: 'a-shop' }],
      ] as const) {
        const visitor = await http()[method](path).set('x-market-id', code).send(body);
        expect([method, path, visitor.status, visitor.body]).toEqual([
          method,
          path,
          401,
          {
            statusCode: 401,
            code: expect.stringMatching(/^(access\.unauthenticated|session\.invalid)$/) as unknown,
          },
        ]);
        const seller = await http()[method](path).set(session.headers).send(body);
        expect([method, path, seller.status, seller.body]).toEqual([
          method,
          path,
          403,
          { statusCode: 403, code: 'access.denied' },
        ]);
      }
    });

    it('reads the draft with the seller of the session, Cache-Control no-store', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.read.next = { ok: true, value: { version: 1, general: { phone: '0400' } } };

      const response = await http().get('/sellers/my-file').set(session.headers);

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.body).toEqual({ version: 1, general: { phone: '0400' } });
      const [call] = stubs.read.calls;
      expect(call!.input).toEqual({});
      expect(call!.context.market.marketId).toBe(code);
      expect(call!.context.actor).toMatchObject({ kind: 'authenticated', population: 'seller' });
    });

    it('reads the form descriptors', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.descriptors.next = { ok: true, value: { phone: { maxLength: 32 } } };

      const response = await http().get('/sellers/my-file/form-descriptors').set(session.headers);

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ phone: { maxLength: 32 } });
    });

    it('saves the General group: forwards only the named fields, no-store, CSRF required', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.general.next = { ok: true, value: SAVED };

      const noToken = await http()
        .put('/sellers/my-file/general')
        .set({ ...session.headers, 'x-csrf-token': '' })
        .send({ phone: '0400' });
      const saved = await http()
        .put('/sellers/my-file/general')
        .set(session.headers)
        .send({ storeName: 'Shop', phone: '0400', contactEmail: null });

      expect(noToken.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      expect(saved.status).toBe(200);
      expect(saved.body).toEqual(SAVED);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(stubs.general.calls).toHaveLength(1);
      expect(stubs.general.calls[0]!.input).toEqual({
        storeName: 'Shop',
        phone: '0400',
        contactEmail: null,
      });
    });

    it('refuses unknown fields (a seller id, a state), wrong types and long values without calling the use case', async () => {
      await boot(true);
      const session = await signedIn(code);
      const put = (body: unknown) =>
        http()
          .put('/sellers/my-file/general')
          .set(session.headers)
          .send(body as object);

      const unknown = await put({ phone: '1', sellerId: 'x', marketId: 'AU', state: 'approved' });
      const wrongType = await put({ phone: 12 });
      const tooLong = await put({ businessName: 'x'.repeat(600) });
      const array = await put([]);

      expect(unknown.status).toBe(400);
      expect(unknown.body).toEqual({
        statusCode: 400,
        code: 'validation.failed',
        details: {
          fields: [
            { path: 'marketId', code: 'unknown-field' },
            { path: 'sellerId', code: 'unknown-field' },
            { path: 'state', code: 'unknown-field' },
          ],
        },
      });
      expect(detailsOf(wrongType)).toEqual({ fields: [{ path: 'phone', code: 'type' }] });
      expect(detailsOf(tooLong)).toEqual({ fields: [{ path: 'businessName', code: 'length' }] });
      expect(detailsOf(array)).toEqual({ fields: [{ path: '', code: 'type' }] });
      expect(JSON.stringify([unknown.body, wrongType.body, tooLong.body])).not.toContain('xxxx');
      expect(stubs.general.calls).toHaveLength(0);
    });

    it('answers 415 to a body that is not JSON and 400 to malformed JSON', async () => {
      await boot(true);
      const session = await signedIn(code);

      const text = await http()
        .put('/sellers/my-file/general')
        .set(session.headers)
        .set('content-type', 'text/plain')
        .send('phone=1');
      const malformed = await http()
        .put('/sellers/my-file/general')
        .set(session.headers)
        .set('content-type', 'application/json')
        .send('{"phone": "SECRET-VALUE"');

      expect(text.status).toBe(415);
      expect(text.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
      expect(malformed.status).toBe(400);
      expect(malformed.body).toEqual({ statusCode: 400, code: 'request.body-malformed' });
      expect(JSON.stringify(malformed.body)).not.toContain('SECRET-VALUE');
      expect(stubs.general.calls).toHaveLength(0);
    });

    it('saves the address and forwards the optional zone fields', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.address.next = { ok: true, value: { ...SAVED, outsideServiceArea: false } };
      const body = {
        address: { line1: '1 George St', postcode: '4000' },
        registeredAddress: null,
        timezone: 'Australia/Brisbane',
        browserTimezone: 'Australia/Sydney',
      };

      const saved = await http().put('/sellers/my-file/address').set(session.headers).send(body);
      const noAddress = await http().put('/sellers/my-file/address').set(session.headers).send({});
      const badNested = await http()
        .put('/sellers/my-file/address')
        .set(session.headers)
        .send({ address: { line1: 5, postcode: 'y'.repeat(300) }, sellerId: 'x' });

      expect(saved.status).toBe(200);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(stubs.address.calls[0]!.input).toEqual(body);
      expect(detailsOf(noAddress)).toEqual({ fields: [{ path: 'address', code: 'required' }] });
      expect(detailsOf(badNested)).toEqual({
        fields: [
          { path: 'sellerId', code: 'unknown-field' },
          { path: 'address', code: 'type' },
          { path: 'address', code: 'length' },
        ],
      });
      expect(stubs.address.calls).toHaveLength(1);
    });

    it('checks a slug from a POST body', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.slug.next = { ok: true, value: { code: 'slug.available', slug: 'a-shop' } };

      const checked = await http()
        .post('/sellers/my-file/slug-check')
        .set(session.headers)
        .send({ slug: 'A-Shop' });
      const missing = await http()
        .post('/sellers/my-file/slug-check')
        .set(session.headers)
        .send({});

      expect(checked.status).toBe(200);
      expect(checked.headers['cache-control']).toBe('no-store');
      expect(checked.body).toEqual({ code: 'slug.available', slug: 'a-shop' });
      expect(stubs.slug.calls[0]!.input).toEqual({ slug: 'A-Shop' });
      expect(detailsOf(missing)).toEqual({ fields: [{ path: 'slug', code: 'required' }] });
    });

    it('saves a slug from a PUT body with only the slug, and answers the draft-saved shape', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.saveSlug.next = { ok: true, value: { ...SAVED, missing: ['address'] } };

      const saved = await http()
        .put('/sellers/my-file/slug')
        .set(session.headers)
        .send({ slug: 'A-Shop' });

      expect(saved.status).toBe(200);
      expect(saved.headers['cache-control']).toBe('no-store');
      expect(saved.body).toEqual({ ...SAVED, missing: ['address'] });
      expect(stubs.saveSlug.calls[0]!.input).toEqual({ slug: 'A-Shop' });
      expect(stubs.saveSlug.calls[0]!.context.market.marketId).toBe(code);

      // Extra fields (a seller or a Market from the client) are refused before the use case.
      const calls = stubs.saveSlug.calls.length;
      const extra = await http()
        .put('/sellers/my-file/slug')
        .set(session.headers)
        .send({ slug: 'a-shop', sellerId: 'x', marketId: 'ZZ' });
      const missing = await http().put('/sellers/my-file/slug').set(session.headers).send({});
      expect(extra.status).toBe(400);
      expect(detailsOf(extra)).toEqual({
        fields: [
          { path: 'marketId', code: 'unknown-field' },
          { path: 'sellerId', code: 'unknown-field' },
        ],
      });
      expect(detailsOf(missing)).toEqual({ fields: [{ path: 'slug', code: 'required' }] });
      expect(stubs.saveSlug.calls).toHaveLength(calls);
    });

    it.each([
      ['slug.format', 400],
      ['slug.reserved', 400],
      ['slug.taken', 409],
      ['file.not-found', 404],
      ['file.change-request-required', 409],
      ['conflict.stale', 409],
    ] as const)('maps the slug save failure %s to %i', async (failure, status) => {
      await boot(true);
      const session = await signedIn(code);
      stubs.saveSlug.next = { ok: false, error: { code: failure } };

      const response = await http()
        .put('/sellers/my-file/slug')
        .set(session.headers)
        .send({ slug: 'a-shop' });

      expect(response.status).toBe(status);
      expect(response.body).toEqual({ statusCode: status, code: failure });
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['validation.failed', 400, { fields: [{ path: 'phone', code: 'length' }] }],
      ['phone.required', 400, undefined],
      ['timezone.not-selectable', 400, undefined],
      ['file.not-found', 404, undefined],
      ['file.change-request-required', 409, undefined],
      ['conflict.stale', 409, undefined],
      ['sellers.unavailable', 503, undefined],
      ['access.unavailable', 503, undefined],
      ['access.denied', 403, undefined],
    ] as const)(
      'maps %s to %i with the error format and no-store',
      async (failure, status, details) => {
        await boot(true);
        const session = await signedIn(code);
        stubs.general.next = { ok: false, error: { code: failure, ...(details ?? {}) } };

        const response = await http()
          .put('/sellers/my-file/general')
          .set(session.headers)
          .send({ phone: '0400' });

        expect(response.status).toBe(status);
        expect(response.body).toEqual({
          statusCode: status,
          code: failure,
          ...(details ? { details } : {}),
        });
        expect(response.headers['cache-control']).toBe('no-store');
      },
    );

    it('maps request.throttled to 429 with Retry-After', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.slug.next = { ok: false, error: { code: 'request.throttled', retryAfterSeconds: 42 } };

      const response = await http()
        .post('/sellers/my-file/slug-check')
        .set(session.headers)
        .send({ slug: 'a-shop' });

      expect(response.status).toBe(429);
      expect(response.headers['retry-after']).toBe('42');
      expect(response.body).toEqual({
        statusCode: 429,
        code: 'request.throttled',
        details: { retryAfterSeconds: 42 },
      });
    });

    it.each([
      ['put', '/sellers/my-file/general', { phone: '0400' }],
      ['put', '/sellers/my-file/address', { address: { line1: 'x' } }],
      ['put', '/sellers/my-file/slug', { slug: 'a-shop' }],
      ['post', '/sellers/my-file/slug-check', { slug: 'a-shop' }],
    ] as const)(
      '%s %s: a missing or invalid CSRF token answers 403 request.csrf, no-store, without a call',
      async (method, path, body) => {
        await boot(true);
        const session = await signedIn(code);
        const withoutToken = {
          'x-market-id': session.headers['x-market-id'],
          cookie: session.headers.cookie,
        };
        const missing = await http()[method](path).set(withoutToken).send(body);
        const invalid = await http()
          [method](path)
          .set({ ...session.headers, 'x-csrf-token': 'not-the-token' })
          .send(body);

        for (const response of [missing, invalid]) {
          expect(response.status).toBe(403);
          expect(response.body).toEqual({ statusCode: 403, code: 'request.csrf' });
          expect(response.headers['cache-control']).toBe('no-store');
        }
        expect(Object.values(stubs).flatMap((stub) => stub.calls)).toHaveLength(0);
      },
    );

    it.each([
      ['put', '/sellers/my-file/general', { phone: '0400' }, 'general'],
      ['put', '/sellers/my-file/address', { address: { line1: 'x' } }, 'address'],
      ['put', '/sellers/my-file/slug', { slug: 'a-shop' }, 'saveSlug'],
    ] as const)(
      '%s %s: request.throttled answers 429 with Retry-After',
      async (method, path, body, stub) => {
        await boot(true);
        const session = await signedIn(code);
        stubs[stub].next = {
          ok: false,
          error: { code: 'request.throttled', retryAfterSeconds: 7 },
        };

        const response = await http()[method](path).set(session.headers).send(body);

        expect(response.status).toBe(429);
        expect(response.headers['retry-after']).toBe('7');
        expect(response.headers['cache-control']).toBe('no-store');
      },
    );

    it('content-type edges: charset accepted, vendor JSON 415, empty body, {} and over-size body', async () => {
      await boot(true);
      const session = await signedIn(code);
      stubs.general.next = { ok: true, value: SAVED };
      const put = () => http().put('/sellers/my-file/general').set(session.headers);

      const charset = await put()
        .set('content-type', 'application/json; charset=utf-8')
        .send('{"phone":"0400"}');
      const vendor = await put().set('content-type', 'application/vnd.api+json').send('{}');
      const empty = await put().send();
      const emptyObject = await put().send({});
      const calls = stubs.general.calls.length;
      const huge = await put()
        .set('content-type', 'application/json')
        .send(JSON.stringify({ phone: 'x'.repeat(70_000) }));

      expect(charset.status).toBe(200);
      expect(vendor.status).toBe(415);
      expect(vendor.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
      expect([empty.status, emptyObject.status]).toEqual([415, 200]);
      expect(empty.body).toEqual({ statusCode: 415, code: 'request.body-unsupported' });
      expect(calls).toBe(2);
      expect(huge.status).toBe(413);
      expect(huge.body).toEqual({ statusCode: 413, code: 'request.body-too-large' });
      expect(stubs.general.calls).toHaveLength(calls);
    });

    it('is in the OpenAPI document with its six routes, the CSRF header, 415 and 429', async () => {
      await boot(true, { API_DOCS_ENABLED: 'true' });

      const response = await http().get('/docs-json').expect(200);

      type Operation = {
        parameters?: { name: string }[];
        responses: Record<string, unknown>;
      };
      const paths = (response.body as { paths: Record<string, Record<string, Operation>> }).paths;
      const routes = [
        ['get', '/sellers/my-file'],
        ['get', '/sellers/my-file/form-descriptors'],
        ['put', '/sellers/my-file/general'],
        ['put', '/sellers/my-file/address'],
        ['put', '/sellers/my-file/slug'],
        ['post', '/sellers/my-file/slug-check'],
      ] as const;
      for (const [method, path] of routes) expect(paths[path]?.[method]).toBeDefined();
      for (const [method, path] of routes.slice(2)) {
        const operation = paths[path]![method]!;
        expect(operation.parameters?.map((p) => p.name.toLowerCase())).toContain('x-csrf-token');
        expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['415', '429']));
      }
    });

    it('maps the read failures (404, 503)', async () => {
      await boot(true);
      const session = await signedIn(code);

      stubs.read.next = { ok: false, error: { code: 'file.not-found' } };
      const missing = await http().get('/sellers/my-file').set(session.headers);
      stubs.read.next = { ok: false, error: { code: 'sellers.unavailable' } };
      const unavailable = await http().get('/sellers/my-file').set(session.headers);

      expect([missing.status, unavailable.status]).toEqual([404, 503]);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect(unavailable.headers['cache-control']).toBe('no-store');
    });
  });
});
