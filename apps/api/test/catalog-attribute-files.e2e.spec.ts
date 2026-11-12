import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import { ATTRIBUTE_DEFINITION_STORE } from '../src/modules/catalog/application/ports/attribute-definition.store';
import { ATTRIBUTE_RELAXATION_STORE } from '../src/modules/catalog/application/ports/attribute-relaxation.store';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { RATE_COUNTER_REPOSITORY } from '../src/modules/catalog/application/ports/rate-counter.repository';
import { ATTRIBUTE_FILE_STATUS } from '../src/modules/catalog/presentation/attribute-file.controller';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
} from './support/catalog-attribute-admin-fakes';
import {
  MemoryAttributeDefinitionStore,
  MemoryAttributeRelaxationStore,
  claimLocalesOf,
  halalOnlyMatcher,
} from './support/catalog-attribute-editor-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The attribute export and import over HTTP (attributes package A9): the real guards, controller,
// gate with the real role seed and the use cases; the readers, the store, the claim matcher and
// the rate counters as in-memory fakes. Proved in both Market fixtures: the export needs only the
// view key (a reader downloads a CSV, Finance gets 403, no session 401); the import needs the two
// protected keys that no default role holds (a reader is refused with 403); the CSRF token, JSON
// and the closed body; the diff of the check; the run, tied to the checked file by its SHA-256,
// creating a draft through the editor and refusing a claim word per row with a code only; and the
// OpenAPI document.

const START = Temporal.Instant.from('2026-11-11T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const READER = id<'Account'>(0xc701);
const IMPORTER = id<'Account'>(0xc702);
const FINANCE = id<'Account'>(0xc703);
const READER_ROLE = id<'Role'>(0xc801);
const IMPORTER_ROLE = id<'Role'>(0xc802);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('attribute export and import over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const store = new MemoryAttributeDefinitionStore();
  const reader = new MemoryAttributeAdminReader();
  const clock = new FixedClock(START);
  const http = () => request(app.getHttpServer());
  const marketOf = (code: string): MarketContext => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(ATTRIBUTE_ADMIN_READER)
          .useValue(reader)
          .overrideProvider(ATTRIBUTE_DEFINITION_STORE)
          .useValue(store)
          .overrideProvider(ATTRIBUTE_RELAXATION_STORE)
          .useValue(new MemoryAttributeRelaxationStore())
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalOnlyMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              claimLocalesOf(localesOf(context.market.marketId)).covered(context as never),
          })
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
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'attr-0003'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    for (const [roleId, name, permissionKeys] of [
      [READER_ROLE, 'Attribute reader', ['catalog.attribute.view']],
      [
        IMPORTER_ROLE,
        'Attribute importer',
        ['catalog.attribute.view', 'catalog.attribute.edit', 'catalog.attribute.import'],
      ],
    ] as const) {
      fakes.seedRole({
        id: roleId,
        marketId,
        scope: 'platform',
        kind: 'custom',
        seedCode: null,
        seedVersion: null,
        sellerId: null,
        name,
        permissionKeys: [...permissionKeys],
        version: 1,
        createdAt: START,
      });
    }
    let n = 0;
    for (const [accountId, label, roleId] of [
      [READER, 'reader', READER_ROLE],
      [IMPORTER, 'importer', IMPORTER_ROLE],
      [FINANCE, 'finance', roleOf('finance')],
    ] as const) {
      n += 1;
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
        id: id<'RoleAssignment'>(0xe900 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    reader.seedDefinition(
      code,
      definitionRecord(id<'AttributeDefinition'>(0xc901), 'pack-size', {
        dataType: 'select',
        names: { [localeOf(code)]: 'Pack size' },
        values: [
          { code: 'g250', labels: { [localeOf(code)]: '250 g' }, active: true, position: 0 },
        ],
      }),
    );
    reader.optionCounts.set(`${code}:pack-size:g250`, 4);
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xfa00 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: START,
      }),
      issued.tokenHash,
    );
    return {
      'x-market-id': code,
      ...panelHeaders(code, 'admin'),
      cookie: `__Host-session-admin-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const EXPORT = '/catalog/admin/attribute-files/export';
  const CHECK = '/catalog/admin/attribute-imports/check';
  const RUN = '/catalog/admin/attribute-imports/run';
  const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

  beforeEach(() => {
    fakes.reset();
    store.reset();
    reader.reset();
  });
  afterEach(async () => {
    await app?.close();
  });

  it('maps the refusals of the attribute file routes to their status', () => {
    expect(ATTRIBUTE_FILE_STATUS).toMatchObject({
      'validation.failed': 400,
      'batch.too-large': 413,
      'file.too-large': 413,
      'file.unsupported-type': 415,
      'file.too-many-rows': 422,
      'columns.kind-unknown': 422,
      'columns.missing': 422,
      'import.file-changed': 409,
      'import.errors-not-skipped': 409,
      'import.nothing-to-import': 409,
      'request.throttled': 429,
      'access.unavailable': 503,
    });
  });

  it('documents the export, the check and the run in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[EXPORT]).toHaveProperty('get');
    expect(document.paths[CHECK]).toHaveProperty('post');
    expect(document.paths[RUN]).toHaveProperty('post');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const locale = localeOf(code);
    const header = `code,type,name[${locale}]`;

    it('keeps the protected import key out of every default role', async () => {
      await boot();
      await seeded(code);
      for (const role of [...fakes.roles.values()].filter(
        (r) => r.marketId === code && r.kind !== 'custom',
      )) {
        expect(role.permissionKeys).not.toContain('catalog.attribute.import');
      }
    }, 30_000);

    it('downloads a CSV for a reader, with the Market language columns and the counts', async () => {
      await boot();
      await seeded(code);
      const answer = await http()
        .get(`${EXPORT}?kind=values`)
        .set(adminSession(code, READER, 1))
        .expect(200);
      expect(answer.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
      expect(answer.headers['content-disposition']).toMatch(
        /^attachment; filename="values-2026-11-11\.csv"$/,
      );
      expect(answer.headers['cache-control']).toBe('no-store');
      expect(answer.headers['x-content-type-options']).toBe('nosniff');
      const raw = answer.text || Buffer.from(answer.body as Buffer).toString('utf8');
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      const lines = text.trim().split('\r\n');
      expect(lines[0]).toContain(`label[${locale}]`);
      expect(lines[1]).toContain('pack-size,g250,yes,0,250 g');
      expect(lines[1]).toContain(',4,');
    }, 30_000);

    it('refuses without a session (401), without the view key (403) and a bad query (400)', async () => {
      await boot();
      await seeded(code);
      await http()
        .get(`${EXPORT}?kind=attributes`)
        .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') })
        .expect(401);
      const denied = await http()
        .get(`${EXPORT}?kind=attributes`)
        .set(adminSession(code, FINANCE, 2))
        .expect(403);
      expect(denied.body).toMatchObject({ code: 'access.denied' });
      const bad = await http()
        .get(`${EXPORT}?kind=products`)
        .set(adminSession(code, READER, 3))
        .expect(400);
      expect(bad.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'kind', code: 'unknown' }] },
      });
    }, 30_000);

    it('refuses an import to a reader: the check and the run need the two protected keys', async () => {
      await boot();
      await seeded(code);
      const reading = adminSession(code, READER, 4);
      for (const route of [CHECK, RUN]) {
        const refused = await http()
          .post(route)
          .set(reading)
          .send({
            data: b64(`${header}\ncut,text,Cut`),
            ...(route === RUN ? { fileSha256: 'a'.repeat(64), planSha256: 'b'.repeat(64) } : {}),
          })
          .expect(403);
        expect(refused.body).toMatchObject({ code: 'access.denied' });
      }
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('checks a file and saves nothing; then runs the same file and creates a draft', async () => {
      await boot();
      await seeded(code);
      const importer = adminSession(code, IMPORTER, 5);
      const data = b64(`${header}\ncut,text,Cut\npack-size,integer,Pack`);
      const checked = await http().post(CHECK).set(importer).send({ data }).expect(200);
      expect(checked.headers['cache-control']).toBe('no-store');
      expect(checked.body).toMatchObject({
        kind: 'attributes',
        counts: { rows: 2, create: 1, update: 0, unchanged: 0, errors: 1 },
        canRun: true,
        rows: [
          { key: 'pack-size', action: 'error', issues: [{ column: 'type', code: 'locked' }] },
          { key: 'cut', action: 'create' },
        ],
      });
      expect(store.rows.size).toBe(0);
      const tokens = checked.body as { fileSha256: string; planSha256: string };
      const fileSha256 = tokens.fileSha256;
      const planSha256 = tokens.planSha256;

      const notSkipped = await http()
        .post(RUN)
        .set(importer)
        .send({ data, fileSha256, planSha256 })
        .expect(409);
      expect(notSkipped.body).toMatchObject({ code: 'import.errors-not-skipped' });
      const changed = await http()
        .post(RUN)
        .set(importer)
        .send({
          data: b64(`${header}\ncut,text,Cut again`),
          fileSha256,
          planSha256,
          skipErrors: true,
        })
        .expect(409);
      expect(changed.body).toMatchObject({ code: 'import.file-changed' });
      expect(store.rows.size).toBe(0);

      const ran = await http()
        .post(RUN)
        .set(importer)
        .send({ data, fileSha256, planSha256, skipErrors: true })
        .expect(200);
      expect(ran.body).toMatchObject({
        kind: 'attributes',
        rows: 2,
        created: 1,
        skipped: 1,
        failed: 0,
        results: [{ rowNumber: 3, key: 'pack-size', result: 'skipped' }],
        report: { filename: 'attributes-import-result-2026-11-11.csv' },
      });
      expect([...store.rows.values()].map((d) => [d.state.code, d.state.status])).toEqual([
        ['cut', 'draft'],
      ]);
    }, 30_000);

    it('fails a row with a claim word by its code and never echoes the text', async () => {
      await boot();
      await seeded(code);
      const importer = adminSession(code, IMPORTER, 6);
      const data = b64(`${header}\nsweet,text,Halal sweet`);
      const checked = await http().post(CHECK).set(importer).send({ data }).expect(200);
      const ran = await http()
        .post(RUN)
        .set(importer)
        .send({
          data,
          fileSha256: (checked.body as { fileSha256: string }).fileSha256,
          planSha256: (checked.body as { planSha256: string }).planSha256,
        })
        .expect(200);
      expect(ran.body).toMatchObject({
        failed: 1,
        results: [{ key: 'sweet', result: 'failed', code: 'attribute.claim-word' }],
      });
      expect(JSON.stringify(ran.body)).not.toMatch(/halal/i);
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('needs the CSRF token, JSON, a closed body and a readable file', async () => {
      await boot();
      await seeded(code);
      const importer = adminSession(code, IMPORTER, 7);
      const withoutCsrf: Record<string, string> = { ...importer };
      delete withoutCsrf['x-csrf-token'];
      await http()
        .post(CHECK)
        .set(withoutCsrf)
        .send({ data: b64('x') })
        .expect(403);
      await http()
        .post(CHECK)
        .set({ ...importer, 'content-type': 'text/plain' })
        .send('x')
        .expect(415);
      const unknown = await http()
        .post(CHECK)
        .set(importer)
        .send({ data: b64('x'), colour: 'red' })
        .expect(400);
      expect(unknown.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'colour', code: 'unknown-field' }] },
      });
      await http()
        .post(RUN)
        .set(importer)
        .send({ data: b64('x') })
        .expect(400);
      const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]).toString('base64');
      await http().post(CHECK).set(importer).send({ data: zip }).expect(415);
      const unknownFile = await http()
        .post(CHECK)
        .set(importer)
        .send({ data: b64('colour,size\nred,1') })
        .expect(422);
      expect(unknownFile.body).toMatchObject({ code: 'columns.kind-unknown' });
      expect(store.rows.size).toBe(0);
    }, 30_000);
  });
});
