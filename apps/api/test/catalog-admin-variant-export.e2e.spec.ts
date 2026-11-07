import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { ADMIN_PRODUCTS_READER } from '../src/modules/catalog/application/ports/admin-products.reader';
import {
  ADMIN_VARIANTS_READER,
  type AdminVariantRow,
} from '../src/modules/catalog/application/ports/admin-variants.reader';
import { ADMIN_VARIANT_EXPORT_STATUS } from '../src/modules/catalog/presentation/admin-variant-export.controller';
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
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The admin variant file over HTTP (catalog design 14b): the real guards, controller, gate and use
// case, with identity's ports and the two readers as in-memory fakes. Proved here: the admin
// session and the view key, the closed query and its status, the attachment headers, the columns
// (the union of the axes of the exported products), the formula guard in CSV, every XLSX cell as a
// string, and the 10,000 row cap. The reader itself is in test/db/catalog-admin-variants.db-spec.ts.

const START = Temporal.Instant.from('2026-11-07T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const VIEWER = id<'Account'>(0xa102);
const NO_KEY = id<'Account'>(0xa103);
const NO_KEY_ROLE = id<'Role'>(0xc1f2);
const SHIRT = id<'Product'>(0xc101);
const MUG = id<'Product'>(0xc102);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

it('maps the refusal codes of the variant export to their statuses', () => {
  expect(ADMIN_VARIANT_EXPORT_STATUS).toEqual({
    'validation.failed': 400,
    'export.too-large': 413,
    'access.unavailable': 503,
  });
});

function binary(
  res: request.Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function firstSheet(bytes: Buffer): Promise<ExcelJS.Worksheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as never);
  return workbook.worksheets[0]!;
}

function cellsOf(sheet: ExcelJS.Worksheet, row: number): string[] {
  const values: string[] = [];
  sheet.getRow(row).eachCell({ includeEmpty: true }, (cell) => values.push(cell.text));
  return values;
}

describe('admin variant export over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let readLocales: string[];
  let counted: number;
  let tooManyProducts: boolean;
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);

  /** A shirt with two axes (one label is a formula) and a mug with none. */
  const rowsOf = (code: string, label: string): AdminVariantRow[] => [
    {
      productId: SHIRT,
      productCode: `${code}-000001`,
      typeCode: 'simple',
      variantCode: `${code}-000001-01`,
      options: [
        { attributeCode: 'color', optionCode: 'red', label: 'Red' },
        { attributeCode: 'size', optionCode: 'l', label },
      ],
      gtin: '00012345678905',
      offerCount: 3,
    },
    {
      productId: MUG,
      productCode: `${code}-000002`,
      typeCode: 'simple',
      variantCode: `${code}-000002-01`,
      options: [],
      gtin: null,
      offerCount: 0,
    },
  ];

  async function boot(code: string, label = 'Large') {
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
          .overrideProvider(ADMIN_PRODUCTS_READER)
          .useValue({
            counts: () => Promise.resolve([12_345]),
            ids: () =>
              Promise.resolve(
                tooManyProducts ? Array.from({ length: 10_001 }, () => SHIRT) : [SHIRT, MUG],
              ),
          })
          .overrideProvider(ADMIN_VARIANTS_READER)
          .useValue({
            count: () => Promise.resolve(counted),
            axisCodes: () => Promise.resolve(['color', 'size']),
            rows: (_m: MarketContext, _ids: readonly string[], locale: string) => {
              readLocales.push(locale);
              return Promise.resolve(rowsOf(code, label));
            },
          }),
    }));
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'var-0001'), {});
    const marketId = code as AccountState['marketId'];
    fakes.seedRole({
      id: NO_KEY_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'No catalog key',
      permissionKeys: ['identity.admin-account.view'],
      version: 1,
      createdAt: START,
    });
    const viewerRole = [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === 'viewer',
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
    admin(VIEWER, 'viewer', viewerRole, 1);
    admin(NO_KEY, 'nokey', NO_KEY_ROLE, 2);
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

  const exportOf = (code: string, query: string, session: Record<string, string> | null) =>
    http()
      .get(`/catalog/admin/variants/export${query}`)
      .set({
        'x-market-id': code,
        ...panelHeaders(code, 'admin'),
        ...(session === null ? {} : { cookie: session.cookie! }),
      });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    readLocales = [];
    counted = 2;
    tooManyProducts = false;
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its error codes in OpenAPI', async () => {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder).overrideProvider(CLOCK).useValue(clock),
    }));
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, { responses: Record<string, unknown> }>>;
    };
    const get = document.paths['/catalog/admin/variants/export']?.get?.responses;
    for (const status of ['200', '400', '401', '403', '413', '503']) {
      expect(get).toHaveProperty(status);
    }
  }, 30_000);

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('streams the CSV with the union of the axes as a no-store attachment', async () => {
      await boot(code);
      await seeded(code);

      const response = await exportOf(code, '?format=csv', sessionOf(code, VIEWER, 1)).buffer(true);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.headers['content-disposition']).toBe(
        'attachment; filename="variants-2026-11-07.csv"',
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      const lines = response.text
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n');
      expect(lines).toEqual([
        'product_code,variant_code,product_type,option[color],option[size],gtin,offer_count',
        `${code}-000001,${code}-000001-01,simple,Red,Large,00012345678905,3`,
        `${code}-000002,${code}-000002-01,simple,,,,0`,
      ]);
      // The labels are read in the Market's own default locale, never a fixed one.
      expect(readLocales).toHaveLength(1);
      expect(readLocales[0]).toMatch(/^[a-z]{2}(-[A-Za-z]{2,4})?$/);
    });

    it('writes no price, stock or seller column', async () => {
      await boot(code);
      await seeded(code);

      const response = await exportOf(code, '', sessionOf(code, VIEWER, 1)).buffer(true);

      const header = response.text.replace(/^\uFEFF/, '').split('\r\n')[0]!;
      expect(header).not.toMatch(/price|stock|seller|cost/i);
    });

    it('streams an XLSX with the same header and cells as the CSV, every cell a string', async () => {
      await boot(code);
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      const xlsx = await exportOf(code, '?format=xlsx', session).buffer(true).parse(binary);
      const csv = await exportOf(code, '?format=csv', session).buffer(true);

      expect(xlsx.status).toBe(200);
      expect(xlsx.headers['content-type']).toBe(XLSX_TYPE);
      expect(xlsx.headers['content-disposition']).toBe(
        'attachment; filename="variants-2026-11-07.xlsx"',
      );
      const sheet = await firstSheet(xlsx.body as Buffer);
      expect(sheet.name).toBe('Variants');
      expect(sheet.rowCount).toBe(3);
      const lines = csv.text
        .replace(/^\uFEFF/, '')
        .trim()
        .split('\r\n')
        .map((line) => line.split(','));
      expect([1, 2, 3].map((row) => cellsOf(sheet, row))).toEqual(lines);
      sheet.eachRow((row) =>
        row.eachCell({ includeEmpty: false }, (cell) =>
          expect(cell.type).toBe(ExcelJS.ValueType.String),
        ),
      );
    });

    it('guards a formula-like label in CSV and leaves it as text in XLSX', async () => {
      await boot(code, '=HYPERLINK("http://evil.example")');
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      const csv = await exportOf(code, '', session).buffer(true);
      expect(csv.text).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
      expect(csv.text).not.toMatch(/(^|,)"?=HYPERLINK/m);

      const xlsx = await exportOf(code, '?format=xlsx', session).buffer(true).parse(binary);
      const sheet = await firstSheet(xlsx.body as Buffer);
      expect(sheet.getCell('E2').value).toBe('=HYPERLINK("http://evil.example")');
      expect(sheet.getCell('E2').type).toBe(ExcelJS.ValueType.String);
    });

    it('refuses more than 10,000 variant rows whole, for both formats', async () => {
      await boot(code);
      await seeded(code);
      counted = 10_001;
      const session = sessionOf(code, VIEWER, 1);

      for (const format of ['csv', 'xlsx']) {
        const response = await exportOf(code, `?format=${format}`, session);
        expect(response.status).toBe(413);
        expect(response.body).toMatchObject({
          code: 'export.too-large',
          details: { max: 10_000, total: 10_001 },
        });
      }
      expect(readLocales).toEqual([]);
    });

    it('refuses more than 10,000 products whole', async () => {
      await boot(code);
      await seeded(code);
      tooManyProducts = true;

      const response = await exportOf(code, '', sessionOf(code, VIEWER, 1));

      expect(response.status).toBe(413);
      expect(response.body).toMatchObject({
        code: 'export.too-large',
        details: { max: 10_000, total: 12_345 },
      });
    });

    it('answers 400 for an unknown format and for a key that is not a list filter', async () => {
      await boot(code);
      await seeded(code);
      const session = sessionOf(code, VIEWER, 1);

      for (const [query, path] of [
        ['?format=xls', 'format'],
        ['?format=XLSX', 'format'],
        ['?columns=price', 'columns'],
        ['?ids=x', 'ids'],
      ] as const) {
        const response = await exportOf(code, query, session);
        expect(response.status).toBe(400);
        expect(response.body).toMatchObject({
          code: 'validation.failed',
          details: { fields: [{ path }] },
        });
      }
    });

    it('answers 401 without a session and 403 without the view key', async () => {
      await boot(code);
      await seeded(code);

      expect((await exportOf(code, '', null)).status).toBe(401);
      expect((await exportOf(code, '', sessionOf(code, NO_KEY, 2))).status).toBe(403);
    });
  });
});
