import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { CATALOG_REFERENCES } from '../src/modules/certification/application/ports/catalog-references';
import { CLAIM_POLICY_REPOSITORY } from '../src/modules/certification/application/ports/claim-policy.repository';
import { REGISTRY_CIPHER } from '../src/modules/certification/application/ports/registry-cipher';
import { CERTIFICATION_REGISTRY_REPOSITORY } from '../src/modules/certification/application/ports/registry.repository';
import type { TypeRevisionContent } from '../src/modules/certification/domain/type-revision';
import { ADMIN_REGISTRY_STATUS } from '../src/modules/certification/presentation/registry-http';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { OUTBOX_WRITER } from '../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../src/platform/market-config/market-config';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { MemoryOutbox } from './support/certification-fakes';
import {
  FakeCatalogReferences,
  MemoryClaimPolicies,
} from './support/certification-claim-policy-fakes';
import { FakeRegistryCipher, MemoryRegistry } from './support/certification-registry-fakes';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { createTestApp } from './support/test-app';
import {
  panelHeaders,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
  TEST_MARKETS,
  testMarketId,
} from './support/test-config';

// The claim basis policy routes over HTTP (certification slice 13; CERT-42; H1): the real guards,
// CSRF, closed bodies, controller, the gate with the real role seed and the use cases; the policy
// store, the registry, its cipher and catalog's references as in-memory fakes. Proved here: the
// protected edit key is in no default role, a default role reads but cannot write, a relaxing
// revision waits for a second editor and its author cannot approve it, the status of the refusals,
// and that the change reason reaches no log line, event or audit row.

const START = Temporal.Instant.from('2026-10-18T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const REASON = 'Canary-Reason-4Q9 of Nowhere';
const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR_A = id<'Account'>(0xb301);
const EDITOR_B = id<'Account'>(0xb302);
const MODERATOR = id<'Account'>(0xb303);
const TYPE = id<'CertificationType'>(0xc311);
const TYPE_REVISION = id<'CertificationTypeRevision'>(0xc411);
const FOOD = id<'Category'>(0xd101);
const UNKNOWN_CATEGORY = id<'Category'>(0xd1ff);
const EDITOR_ROLE = id<'Role'>(0xf411);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('claim basis policy routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let registry: MemoryRegistry;
  let policies: MemoryClaimPolicies;
  let catalog: FakeCatalogReferences;
  let outbox: MemoryOutbox;
  let logged: string[];
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(OUTBOX_WRITER)
          .useValue(outbox)
          .overrideProvider(CERTIFICATION_REGISTRY_REPOSITORY)
          .useValue(registry)
          .overrideProvider(CLAIM_POLICY_REPOSITORY)
          .useValue(policies)
          .overrideProvider(CATALOG_REFERENCES)
          .useValue(catalog)
          .overrideProvider(REGISTRY_CIPHER)
          .useValue(new FakeRegistryCipher()),
    }));
    const out = process.stdout.write.bind(process.stdout);
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown, ...rest: unknown[]) => {
      logged.push(String(chunk));
      return (out as (...a: unknown[]) => boolean)(chunk, ...rest);
    });
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);

  async function seeded(code: string) {
    const market = marketOf(code);
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'policy-0001'), {});
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
      name: 'Policy editor',
      permissionKeys: ['certification.claim-policy.view', 'certification.claim-policy.edit'],
      version: 1,
      createdAt: START,
    });
    let n = 0;
    const account = (accountId: Id<'Account'>, label: string, roleId: Id<'Role'>) => {
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
        id: id<'RoleAssignment'>(0xe960 + n),
        marketId,
        accountId,
        roleId,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    account(EDITOR_A, 'editor-a', EDITOR_ROLE);
    account(EDITOR_B, 'editor-b', EDITOR_ROLE);
    account(MODERATOR, 'moderator', roleOf('catalogue-moderator'));

    const locales = configs.get(testMarketId(code))!.supportedLocales;
    const content: TypeRevisionContent = {
      verificationMode: 'THIRD_PARTY_DOCUMENT',
      requiresIssuerRegistry: true,
      requiresDocument: true,
      requiresExpiry: true,
      defaultBasis: 'SELLER_REQUIRED',
      autoApproveSelfDeclaration: false,
      badgeIconKey: 'seal',
      locales: Object.fromEntries(
        locales.map((l) => [
          l,
          { name: 'Qorvane', customerDescription: 'Holds a certificate.', claimTerms: ['qorvane'] },
        ]),
      ),
    };
    registry.addType(
      market,
      { id: TYPE, code: 'qorvane', status: 'active' },
      { id: TYPE_REVISION, content },
      START,
      'seed',
    );
    catalog.add(market, FOOD);
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf700 + n),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population: 'admin',
        sellerId: null,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
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

  const base = '/certification/admin/claim-policies';
  const row = (basis: string) => ({ selector: 'platform-category', categoryId: FOOD, basis });

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    registry = new MemoryRegistry();
    policies = new MemoryClaimPolicies(registry);
    catalog = new FakeCatalogReferences();
    outbox = new MemoryOutbox();
    logged = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('maps the policy refusals to their status', () => {
    expect(ADMIN_REGISTRY_STATUS).toMatchObject({
      'claim-policy.revision-unchanged': 409,
      'claim-policy.revision-invalid': 422,
      'review.second-admin-required': 403,
      'review.proposal-pending': 409,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('keeps the protected edit key out of every default role; a default role reads but cannot write', async () => {
      await boot();
      await seeded(code);
      for (const role of [...fakes.roles.values()].filter(
        (r) => r.marketId === code && r.kind !== 'custom',
      )) {
        expect(role.permissionKeys).not.toContain('certification.claim-policy.edit');
      }
      const moderator = sessionOf(code, MODERATOR, 1);
      const read = await http().get(`${base}/${TYPE}`).set(moderator).expect(200);
      expect(read.headers['cache-control']).toContain('no-store');
      expect(read.body).toMatchObject({
        typeId: TYPE,
        defaultBasis: 'SELLER_REQUIRED',
        version: 0,
        published: null,
      });
      const refused = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(moderator)
        .send({ version: 0, rows: [row('NOT_APPLICABLE')] })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      expect(policies.state.policies.size).toBe(0);
    }, 30_000);

    it('publishes a tightening revision; a relaxing one waits for a second editor (H1)', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 2);
      const b = sessionOf(code, EDITOR_B, 3);

      const first = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 0, rows: [row('NOT_APPLICABLE')], reason: REASON })
        .expect(200);
      expect(first.body).toMatchObject({ outcome: 'published', revisionNo: 1, version: 2 });

      const relaxing = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 2, rows: [row('SELLER_OR_MANUFACTURER')], reason: REASON })
        .expect(200);
      expect(relaxing.body).toMatchObject({ outcome: 'pending-second-admin', version: 2 });
      const proposalId = (relaxing.body as { proposalId: string }).proposalId;

      const own = await http()
        .post(`${base}/${TYPE}/relaxations/${proposalId}/approve`)
        .set(a)
        .send({ version: 1 })
        .expect(403);
      expect(own.body).toMatchObject({ code: 'review.second-admin-required' });
      // Only the author withdraws.
      await http()
        .post(`${base}/${TYPE}/proposals/${proposalId}/withdraw`)
        .set(b)
        .send({ version: 1 })
        .expect(403);
      const approved = await http()
        .post(`${base}/${TYPE}/relaxations/${proposalId}/approve`)
        .set(b)
        .send({ version: 1 })
        .expect(200);
      expect(approved.body).toMatchObject({ state: 'approved', policyVersion: 3 });

      const read = await http().get(`${base}/${TYPE}`).set(b).expect(200);
      expect(read.body).toMatchObject({
        version: 3,
        published: {
          revisionNo: 2,
          rows: [row('SELLER_OR_MANUFACTURER')],
          reason: { state: 'given', text: REASON },
        },
        pendingRevision: null,
      });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.claim-policy-changed.v1',
        'certification.relaxation-proposed.v1',
        'certification.claim-policy-changed.v1',
      ]);
      expect(fakes.audits.map((x) => x.action)).toEqual(
        expect.arrayContaining([
          'certification.claim-policy.revised',
          'certification.claim-policy.relaxation-requested',
          'certification.claim-policy.relaxation-approved',
        ]),
      );
      // The reason is read back on the page only: no log line, event or audit row holds it.
      const everything = JSON.stringify({ logged, events: outbox.events, audits: fakes.audits });
      expect(everything).not.toContain('Canary-Reason');
    }, 30_000);

    it('refuses invalid rows with 422 and their issues, an unchanged revision and a stale version with 409', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 4);
      const handling = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({
          version: 0,
          rows: [
            { selector: 'handling', handling: 'SEALED_ORIGINAL', basis: 'SELLER_OR_MANUFACTURER' },
          ],
        })
        .expect(422);
      expect(handling.body).toMatchObject({ code: 'claim-policy.revision-invalid' });
      expect(JSON.stringify(handling.body)).toContain('manufacturer-basis-on-handling');
      const unknown = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({
          version: 0,
          rows: [
            {
              selector: 'platform-category',
              categoryId: UNKNOWN_CATEGORY,
              basis: 'NOT_APPLICABLE',
            },
          ],
        })
        .expect(422);
      expect(JSON.stringify(unknown.body)).toContain('category-unknown');
      await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 0, rows: [row('NOT_APPLICABLE')] })
        .expect(200);
      const same = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 2, rows: [row('NOT_APPLICABLE')] })
        .expect(409);
      expect(same.body).toMatchObject({ code: 'claim-policy.revision-unchanged' });
      const stale = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 0, rows: [] })
        .expect(409);
      expect(stale.body).toMatchObject({ code: 'conflict.stale' });
    }, 30_000);

    it('takes a closed JSON body with the CSRF token only', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 5);
      const noCsrf: Partial<typeof a> = { ...a };
      delete noCsrf['x-csrf-token'];
      await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(noCsrf)
        .send({ version: 0, rows: [row('NOT_APPLICABLE')] })
        .expect(403);
      const extra = await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .send({ version: 0, rows: [row('NOT_APPLICABLE')], publish: true })
        .expect(400);
      expect(extra.body).toMatchObject({ code: 'validation.failed' });
      await http()
        .post(`${base}/${TYPE}/revisions`)
        .set(a)
        .set('content-type', 'text/plain')
        .send('version=0')
        .expect(415);
      await http().get(`${base}/not-an-id`).set(a).expect(400);
      expect(policies.state.policies.size).toBe(0);
    }, 30_000);
  });
});
