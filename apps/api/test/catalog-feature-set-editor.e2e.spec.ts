import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { ATTRIBUTE_ADMIN_READER } from '../src/modules/catalog/application/ports/attribute-admin.reader';
import { FEATURE_SET_STORE } from '../src/modules/catalog/application/ports/feature-set.store';
import { ATTRIBUTE_RELAXATION_STORE } from '../src/modules/catalog/application/ports/attribute-relaxation.store';
import { CLAIM_TERM_LOCALES } from '../src/modules/catalog/application/ports/claim-term-locales';
import { CLAIM_TEXT_MATCHER } from '../src/modules/catalog/application/ports/claim-text-matcher';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import {
  MemoryAttributeRelaxationStore,
  MemoryFeatureSetStore,
  claimLocalesOf,
  halalOnlyMatcher,
} from './support/catalog-attribute-editor-fakes';
import {
  MemoryAttributeAdminReader,
  definitionRecord,
} from './support/catalog-attribute-admin-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The feature-set editor over HTTP (attributes plan, package A4): the real guards, controller, gate
// with the real role seed and use cases; the store, the definitions, the claim matcher and the
// claim locales as in-memory fakes. Proved in both Market fixtures: the protected edit key is in no
// default role, so a Catalogue Moderator cannot write; an admin with a custom role holding the key
// creates a feature set (201) and saves a revision, and is refused a stale version (409), the
// Core group missing or moved (422), an unknown or draft attribute (422), more variant attributes
// than the Market allows (422), a claim word (422, fields only), a locale the vocabulary cannot
// read (422) and the removal of a material attribute (409); the CSRF token, JSON and closed bodies;
// and the OpenAPI document.

const START = Temporal.Instant.from('2026-11-02T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const MODERATOR = id<'Account'>(0xb701);
const EDITOR = id<'Account'>(0xb702);
const EDITOR_ROLE = id<'Role'>(0xb801);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

const dId = (n: number) => `01990000-0000-7000-8000-${(0xd000 + n).toString(16).padStart(12, '0')}`;

describe('feature-set editor over HTTP (integration)', () => {
  let app: NestExpressApplication;
  const store = new MemoryFeatureSetStore();
  const reader = new MemoryAttributeAdminReader();
  let covered: readonly string[] | null = null;
  const http = () => request(app.getHttpServer());

  async function boot(env: Record<string, string> = {}) {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info', ...env },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(new FixedClock(START))
          .overrideProvider(FEATURE_SET_STORE)
          .useValue(store)
          .overrideProvider(ATTRIBUTE_ADMIN_READER)
          .useValue(reader)
          .overrideProvider(ATTRIBUTE_RELAXATION_STORE)
          .useValue(new MemoryAttributeRelaxationStore())
          .overrideProvider(CLAIM_TEXT_MATCHER)
          .useValue(halalOnlyMatcher)
          .overrideProvider(CLAIM_TERM_LOCALES)
          .useValue({
            covered: (context: { market: { marketId: string } }) =>
              claimLocalesOf(covered ?? localesOf(context.market.marketId)).covered(
                context as never,
              ),
          }),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const localeOf = (code: string) => (code === 'AU' ? 'en-AU' : 'ja-JP');
  const localesOf = (code: string) => (code === 'AU' ? ['en-AU'] : ['ja-JP', 'en-US']);

  function seedDefinitions(code: string) {
    const locale = localeOf(code);
    const names = (name: string) => ({ names: { [locale]: name } });
    const select = { dataType: 'select' as const, values: [], ...{} };
    reader.seedDefinition(code, definitionRecord(dId(1), 'brand', names('Brand')));
    reader.seedDefinition(code, definitionRecord(dId(2), 'country-of-origin', names('Country')));
    reader.seedDefinition(
      code,
      definitionRecord(dId(3), 'pack-size', { ...select, ...names('Pack'), isVariantOption: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(4), 'colour', { ...select, ...names('Colour'), isVariantOption: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(5), 'size', { ...select, ...names('Size'), isVariantOption: true }),
    );
    // Six variant attributes in all, one more than any Market may allow (the schema caps at 5).
    for (const [n, extra] of [
      [8, 'v-one'],
      [9, 'v-two'],
      [10, 'v-three'],
    ] as const) {
      reader.seedDefinition(
        code,
        definitionRecord(dId(n), extra, { ...select, ...names(extra), isVariantOption: true }),
      );
    }
    reader.seedDefinition(
      code,
      definitionRecord(dId(6), 'organic', { ...names('Organic'), material: true }),
    );
    reader.seedDefinition(
      code,
      definitionRecord(dId(7), 'draft-one', { ...names('Draft'), status: 'draft' }),
    );
  }

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'attr-0003'), {});
    const marketId = code as AccountState['marketId'];
    const roleOf = (seedCode: string) =>
      [...fakes.roles.values()].find(
        (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
      )!.id;
    fakes.seedRole({
      id: EDITOR_ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Attribute editor',
      permissionKeys: ['catalog.attribute.view', 'catalog.attribute.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    for (const [accountId, label, roleId] of [
      [MODERATOR, 'moderator', roleOf('catalogue-moderator')],
      [EDITOR, 'editor', EDITOR_ROLE],
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
    seedDefinitions(code);
  }

  function adminSession(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf900 + n),
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

  const SETS = '/catalog/admin/feature-sets';

  beforeEach(() => {
    fakes.reset();
    store.reset();
    reader.reset();
    covered = null;
  });
  afterEach(async () => {
    await app?.close();
  });

  it('documents the two editor routes in OpenAPI', async () => {
    await boot({ API_DOCS_ENABLED: 'true' });
    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, Record<string, unknown>>;
    };
    expect(document.paths[SETS]).toHaveProperty('post');
    expect(document.paths[`${SETS}/{featureSetId}`]).toHaveProperty('put');
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const locale = localeOf(code);
    const core = (level = 'required') => ({
      groupCode: 'core',
      names: { [locale]: 'Core' },
      attributes: [
        { code: 'brand', level: 'required' },
        { code: 'country-of-origin', level },
      ],
    });
    const body = (overrides: Record<string, unknown> = {}) => ({
      names: { [locale]: 'Pantry goods' },
      groups: [
        core(),
        {
          names: { [locale]: 'Details' },
          attributes: [{ code: 'pack-size', level: 'recommended' }],
        },
      ],
      ...overrides,
    });

    it('keeps the protected edit key out of every default role; a moderator cannot write', async () => {
      await boot();
      await seeded(code);
      const refused = await http()
        .post(SETS)
        .set(adminSession(code, MODERATOR, 1))
        .send(body())
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('creates a feature set, saves a revision, and refuses a stale version', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 2);
      const created = await http().post(SETS).set(editor).send(body()).expect(201);
      expect(created.body).toEqual({
        featureSet: {
          id: <unknown>expect.any(String),
          code: 'pantry-goods',
          status: 'active',
          version: 1,
          revisionNo: 1,
        },
      });
      const featureSetId = (created.body as { featureSet: { id: string } }).featureSet.id;
      const stored = store.rows.get(featureSetId)!.state;
      expect(stored.groups[1]).toMatchObject({
        groupCode: 'details',
        attributes: [
          { code: 'pack-size', level: 'recommended', required: false, isVariantOption: true },
        ],
      });
      expect(store.authors.map((a) => a.author)).toEqual([EDITOR]);

      const saved = await http()
        .put(`${SETS}/${featureSetId}`)
        .set(editor)
        .send({ ...body({ names: { [locale]: 'Pantry' } }), version: 1 })
        .expect(200);
      expect(saved.body).toMatchObject({ featureSet: { version: 2, revisionNo: 2 } });

      const stale = await http()
        .put(`${SETS}/${featureSetId}`)
        .set(editor)
        .send({ ...body(), version: 1 })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'feature-set.stale' });
      await http()
        .put(`${SETS}/00000000-0000-7000-8000-000000000000`)
        .set(editor)
        .send({ ...body(), version: 1 })
        .expect(404);
    }, 30_000);

    it('refuses a missing Core group, an unknown or draft attribute and too many variant attributes', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 3);
      const noCore = await http()
        .post(SETS)
        .set(editor)
        .send(body({ groups: [{ names: { [locale]: 'Details' }, attributes: [] }] }))
        .expect(422);
      expect(noCore.body).toMatchObject({ code: 'attribute-family.core-invalid' });

      const unknown = await http()
        .post(SETS)
        .set(editor)
        .send(
          body({
            groups: [
              core(),
              { names: { [locale]: 'D' }, attributes: [{ code: 'nope', level: 'optional' }] },
            ],
          }),
        )
        .expect(422);
      expect(unknown.body).toMatchObject({
        code: 'feature-set.attribute-unknown',
        details: { fields: [{ path: 'groups[1].attributes[0].code', code: 'unknown' }] },
      });

      const draft = await http()
        .post(SETS)
        .set(editor)
        .send(
          body({
            groups: [
              core(),
              { names: { [locale]: 'D' }, attributes: [{ code: 'draft-one', level: 'optional' }] },
            ],
          }),
        )
        .expect(422);
      expect(draft.body).toMatchObject({ code: 'feature-set.attribute-not-active' });

      const tooMany = await http()
        .post(SETS)
        .set(editor)
        .send(
          body({
            groups: [
              core(),
              {
                names: { [locale]: 'D' },
                attributes: ['pack-size', 'colour', 'size', 'v-one', 'v-two', 'v-three'].map(
                  (c) => ({
                    code: c,
                    level: 'optional',
                  }),
                ),
              },
            ],
          }),
        )
        .expect(422);
      expect(tooMany.body).toMatchObject({ code: 'feature-set.too-many-variant-attributes' });

      const repeated = await http()
        .post(SETS)
        .set(editor)
        .send(
          body({
            groups: [
              core(),
              { names: { [locale]: 'D' }, attributes: [{ code: 'brand', level: 'optional' }] },
            ],
          }),
        )
        .expect(422);
      expect(repeated.body).toMatchObject({ code: 'attribute-family.attribute-repeated' });
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('refuses a claim word with the field paths only, and a locale the check cannot read', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 4);
      const claim = await http()
        .post(SETS)
        .set(editor)
        .send(body({ names: { [locale]: 'Halal goods' } }))
        .expect(422);
      expect(claim.body).toEqual({
        statusCode: 422,
        code: 'attribute.claim-word',
        details: { fields: [{ path: `names.${locale}`, code: 'claim-word' }] },
      });
      expect(JSON.stringify(claim.body)).not.toMatch(/halal/i);

      covered = [];
      const uncheckable = await http().post(SETS).set(editor).send(body()).expect(422);
      expect(uncheckable.body).toMatchObject({ code: 'attribute.locale-uncheckable' });
      expect(store.rows.size).toBe(0);
    }, 30_000);

    it('refuses an edit that drops a material attribute', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 5);
      const withOrganic = body({
        groups: [
          core(),
          { names: { [locale]: 'D' }, attributes: [{ code: 'organic', level: 'optional' }] },
        ],
      });
      const created = await http().post(SETS).set(editor).send(withOrganic).expect(201);
      const featureSetId = (created.body as { featureSet: { id: string } }).featureSet.id;
      const dropped = await http()
        .put(`${SETS}/${featureSetId}`)
        .set(editor)
        .send({ ...body(), version: 1 })
        .expect(409);
      expect(dropped.body).toMatchObject({
        code: 'feature-set.material-removal-needs-request',
        details: { fields: [{ path: 'groups.d.organic', code: 'material' }] },
      });
      expect(store.rows.get(featureSetId)!.state.version).toBe(1);
    }, 30_000);

    it('needs the CSRF token, JSON and a closed body', async () => {
      await boot();
      await seeded(code);
      const editor = adminSession(code, EDITOR, 6);
      const withoutCsrf: Record<string, string> = { ...editor };
      delete withoutCsrf['x-csrf-token'];
      await http().post(SETS).set(withoutCsrf).send(body()).expect(403);
      await http()
        .post(SETS)
        .set({ ...editor, 'content-type': 'text/plain' })
        .send('x')
        .expect(415);
      const unknown = await http()
        .post(SETS)
        .set(editor)
        .send(body({ colour: 'red' }))
        .expect(400);
      expect(unknown.body).toMatchObject({
        code: 'validation.failed',
        details: { fields: [{ path: 'colour', code: 'unknown-field' }] },
      });
      const entry = await http()
        .post(SETS)
        .set(editor)
        .send(body({ groups: [{ names: {}, attributes: [{ code: 'brand', level: 'must' }] }] }))
        .expect(400);
      expect(entry.body).toMatchObject({ code: 'validation.failed' });
      expect(store.rows.size).toBe(0);
    }, 30_000);
  });
});
