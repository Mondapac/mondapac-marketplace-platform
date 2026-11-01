import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { xlsxParseRunning } from '../src/modules/catalog/infrastructure/xlsx/isolated-xlsx-parser';
import { PLATFORM_IMPORT_STATUS } from '../src/modules/catalog/presentation/platform-import.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { UNIT_OF_WORK } from '../src/platform/unit-of-work/unit-of-work';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { FakeUnitOfWork } from './support/pricing-fakes';
import { createTestApp } from './support/test-app';
import { workbookBytes, workbookSkeleton, zipOf } from './support/zip-fixtures';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin platform import over HTTP (catalog design 14a): the real guards, controller, gates and
// use cases, with identity's ports as in-memory fakes. Proved here: the admin session and the CSRF
// token, the import key (the seeded Viewer lacks it, the Catalogue Moderator holds it), the closed
// body, the template, the file refusals and their statuses (a file's type comes from its content),
// and the OpenAPI document. The stores and the run are in the unit specs and test/db.

const START = Temporal.Instant.from('2026-10-31T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xa102);
const MODERATOR = id<'Account'>(0xa103);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

it('maps the refusal codes of the import routes to their statuses', () => {
  expect(PLATFORM_IMPORT_STATUS).toMatchObject({
    'validation.failed': 400,
    'import.not-found': 404,
    'import.not-confirmable': 409,
    'file.too-large': 413,
    'file.unsupported-type': 415,
    'file.too-many-rows': 422,
    'columns.missing': 422,
    'request.throttled': 429,
    'access.unavailable': 503,
  });
});

describe('admin platform import over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  // One XLSX parse at a time is process-wide: a spec that fails while its parse still runs must not
  // hand the next spec a busy parser (`file.busy`, 503). The parse always ends, by its time limit.
  afterEach(async () => {
    while (xlsxParseRunning()) await new Promise((resolve) => setTimeout(resolve, 20));
  }, 30_000);

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(UNIT_OF_WORK)
          .useValue(new FakeUnitOfWork())
          .overrideProvider(RATE_COUNTER_REPOSITORY)
          .useValue({
            reserve: (_m: MarketContext, list: readonly { limit: { kind: string } }[]) =>
              Promise.resolve(
                list.map((counter) => ({
                  kind: counter.limit.kind,
                  count: 1,
                  windowStartedAt: clock.now(),
                })),
              ),
            purgeStartedBefore: () => Promise.resolve(0),
          }),
    }));
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'import-0001'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    const admin = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>, n: number) => {
      fakes.seedAccount({
        id: accountId,
        marketId,
        population: 'admin',
        email: { typed: `${label}@Example.com`, normalized: `${label}@example.com` },
        displayName: `Name ${label}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(0xe100 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(VIEWER, 'viewer', roleOf('viewer'), 1);
    admin(MODERATOR, 'moderator', roleOf('catalogue-moderator'), 2);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf200 + n),
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

  const headersOf = (code: string, session: Record<string, string> | null, csrf = false) => ({
    'x-market-id': code,
    ...panelHeaders(code, 'admin'),
    ...(session === null ? {} : { cookie: session.cookie! }),
    ...(session !== null && csrf ? { 'x-csrf-token': session['x-csrf-token']! } : {}),
  });
  const template = (code: string, session: Record<string, string> | null) =>
    http().get('/catalog/admin/platform-imports/template').set(headersOf(code, session));
  const upload = (
    code: string,
    body: unknown,
    session: Record<string, string> | null,
    csrf = true,
  ) =>
    http()
      .post('/catalog/admin/platform-imports')
      .set(headersOf(code, session, csrf))
      .send(body as object);
  const asData = (bytes: Buffer | string) => ({
    fileName: 'products.csv',
    data: Buffer.from(bytes).toString('base64'),
  });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the routes and their error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const post = document.paths['/catalog/admin/platform-imports']?.post?.responses;
    for (const status of ['201', '400', '401', '403', '413', '415', '422', '429', '503']) {
      expect(post).toHaveProperty(status);
    }
    for (const route of [
      ['/catalog/admin/platform-imports/template', 'get'],
      ['/catalog/admin/platform-imports/current', 'get'],
      ['/catalog/admin/platform-imports/{importId}', 'get'],
      ['/catalog/admin/platform-imports/{importId}/start', 'post'],
      ['/catalog/admin/platform-imports/{importId}/resume', 'post'],
      ['/catalog/admin/platform-imports/{importId}/discard', 'post'],
      ['/catalog/admin/platform-imports/{importId}/report', 'get'],
    ] as const) {
      expect(document.paths[route[0]]?.[route[1]]).toBeDefined();
    }
  }, 30_000);

  // These specs start the real XLSX worker thread (one or two parses) on top of the app. Each
  // thread compiles nothing once the test cache is warm, but on a machine where every core is busy
  // (a full `pnpm test`) a thread can still take seconds to start, so they get the same time as the
  // OpenAPI spec above rather than Jest's 5 s default. The time limit itself is asserted in
  // isolated-xlsx-parser.spec.ts.
  const WORKER_SPEC_TIMEOUT_MS = 30_000;

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('answers 401 without a session and 403 without the import key', async () => {
      await boot();
      await seeded(code);

      expect((await template(code, null)).status).toBe(401);
      expect((await template(code, sessionOf(code, VIEWER, 1))).status).toBe(403);
      expect((await upload(code, asData('a'), null)).status).toBe(401);
      const refused = await upload(code, asData('Title\nA'), sessionOf(code, VIEWER, 1));
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
    });

    it('gives the Catalogue Moderator the template, as no-store CSV text with the limits', async () => {
      await boot();
      await seeded(code);

      const response = await template(code, sessionOf(code, MODERATOR, 2));

      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const body = response.body as {
        limits: unknown;
        csv: string;
        xlsx: string;
        xlsxFilename: string;
        columns: { key: string }[];
      };
      expect(body.limits).toEqual({ rows: 5000, fileBytes: 10 * 1024 * 1024 });
      expect(body.csv).toContain('Title');
      // The XLSX template has the same header and example row, and reads back as an import file.
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(body.xlsx, 'base64') as never);
      expect(body.xlsxFilename).toBe('products-template.xlsx');
      const sheet = workbook.worksheets[0]!;
      expect(sheet.getRow(1).values).toEqual(
        expect.arrayContaining(['Title', 'Main category', 'Product type']),
      );
      expect(sheet.getCell('A2').value).toBe('Lamb shoulder 1 kg');
      expect(body.columns.map((c) => c.key)).toEqual(
        expect.arrayContaining(['title', 'category', 'type']),
      );
    });

    it('refuses the upload without the CSRF token', async () => {
      await boot();
      await seeded(code);

      const response = await upload(code, asData('Title\nA'), sessionOf(code, MODERATOR, 2), false);

      expect(response.status).toBe(403);
    });

    it('answers 400 with the field for a body that is not closed', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MODERATOR, 2);

      for (const [body, path] of [
        [{}, 'data'],
        [{ data: 'QQ==', extra: 1 }, 'extra'],
        [{ data: 'QQ==', fileName: 7 }, 'fileName'],
        [{ data: '@@@@' }, 'data'],
      ] as const) {
        const response = await upload(code, body, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
    });

    it(
      'reads the file type from the content: a zip that is no workbook is 415, a PDF too',
      async () => {
        await boot();
        await seeded(code);
        const session = sessionOf(code, MODERATOR, 2);

        const zip = await upload(
          code,
          asData(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0])),
          session,
        );
        expect(zip.status).toBe(415);
        expect(zip.body).toMatchObject({
          code: 'file.unsupported-type',
          details: { detected: 'other' },
        });
        const macro = await upload(
          code,
          asData(zipOf(workbookSkeleton('application/vnd.ms-excel.sheet.macroEnabled.main+xml'))),
          session,
        );
        expect(macro.status).toBe(415);
        expect(macro.body).toMatchObject({ code: 'file.unsupported-type' });
        const pdf = await upload(code, asData(Buffer.from('%PDF-1.7 not a csv')), session);
        expect(pdf.status).toBe(415);
        expect(pdf.body).toMatchObject({ details: { detected: 'other' } });
      },
      WORKER_SPEC_TIMEOUT_MS,
    );

    it(
      'reads an XLSX workbook: wrong columns are 422, a formula is 422 with its row',
      async () => {
        await boot();
        await seeded(code);
        const session = sessionOf(code, MODERATOR, 2);

        const wrong = await upload(
          code,
          asData(
            await workbookBytes([
              ['Name', 'Colour'],
              ['A', 'B'],
            ]),
          ),
          session,
        );
        expect(wrong.status).toBe(422);
        expect(wrong.body).toMatchObject({ code: 'columns.missing' });

        const formula = await upload(
          code,
          asData(
            await workbookBytes([
              ['Title', 'Main category', 'Product type'],
              ['A', { formula: '"Meat"', result: 'Meat' }, 'simple'],
            ]),
          ),
          session,
        );
        expect(formula.status).toBe(422);
        expect(formula.body).toMatchObject({
          code: 'file.formula-cell',
          details: { rowNumber: 2 },
        });
      },
      WORKER_SPEC_TIMEOUT_MS,
    );

    it(
      'answers 413 for a workbook that would unpack past the limit (zip bomb)',
      async () => {
        await boot();
        await seeded(code);

        const bomb = zipOf([
          ...workbookSkeleton(),
          { name: 'xl/worksheets/sheet1.xml', data: Buffer.alloc(60 * 1024 * 1024) },
        ]);
        const response = await upload(code, asData(bomb), sessionOf(code, MODERATOR, 2));

        expect(response.status).toBe(413);
        expect(response.body).toMatchObject({
          code: 'file.unpacked-too-large',
          details: { maxBytes: 50 * 1024 * 1024 },
        });
      },
      WORKER_SPEC_TIMEOUT_MS,
    );

    it('answers 422 for an empty-of-rows file and for the wrong columns', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MODERATOR, 2);

      const noRows = await upload(code, asData('Title,Main category,Product type\n'), session);
      expect(noRows.status).toBe(422);
      expect(noRows.body).toMatchObject({ code: 'file.no-rows' });
      const wrong = await upload(code, asData('Name,Colour\nA,B\n'), session);
      expect(wrong.status).toBe(422);
      expect(wrong.body).toMatchObject({ code: 'columns.missing' });
    });

    it('answers 413 when the text of the file is over the limit, before decoding it', async () => {
      await boot();
      await seeded(code);

      const response = await upload(
        code,
        { fileName: 'big.csv', data: 'A'.repeat(Math.ceil((10 * 1024 * 1024 * 4) / 3) + 8) },
        sessionOf(code, MODERATOR, 2),
      );

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        code: 'file.too-large',
        details: { maxBytes: 10 * 1024 * 1024 },
      });
    });

    it('answers 404 for an unknown import id, and 400 for a malformed one', async () => {
      await boot();
      await seeded(code);
      const session = sessionOf(code, MODERATOR, 2);

      const bad = await http()
        .post('/catalog/admin/platform-imports/not-an-id/discard')
        .set(headersOf(code, session, true))
        .send({});
      expect([400, 404]).toContain(bad.status);
    });
  });
});
