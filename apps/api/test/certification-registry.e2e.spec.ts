import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
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

// The type and issuer registry routes over HTTP (certification slice 12; AC 19; H1): the real
// guards, CSRF, closed bodies, controllers, the gate with the real role seed and the use cases;
// the registry and its cipher as in-memory fakes. Proved here: the protected edit keys are in no
// default role and come only through a custom role, a default role reads but cannot write, the
// requester of a reactivation cannot approve it while a second editor can, the status of the
// refusals, and that the expert reference reaches no log line, event or audit row.

const START = Temporal.Instant.from('2026-10-17T00:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };
const REFERENCE = 'Canary-Memo-5X7 of Nowhere';
const NEW_REFERENCE = 'Canary-Memo-8K2 of Nowhere';
const configs = loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS);

const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const EDITOR_A = id<'Account'>(0xa301);
const EDITOR_B = id<'Account'>(0xa302);
const REVIEWER = id<'Account'>(0xa303);
const VIEWER = id<'Account'>(0xa304);
const TYPE = id<'CertificationType'>(0xc301);
const TYPE_REVISION = id<'CertificationTypeRevision'>(0xc401);
const EDITOR_ROLE = id<'Role'>(0xf401);

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();

describe('certification registry routes over HTTP (integration)', () => {
  let app: NestExpressApplication;
  let clock: FixedClock;
  let registry: MemoryRegistry;
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
    await app.get(SeedRoles).execute(testCallContext(market, 'system', 'registry-0001'), {});
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
      name: 'Registry editor',
      permissionKeys: [
        'certification.type.view',
        'certification.type.edit',
        'certification.issuer.view',
        'certification.issuer.edit',
      ],
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
        id: id<'RoleAssignment'>(0xe950 + n),
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
    account(REVIEWER, 'reviewer', roleOf('certification-reviewer'));
    account(VIEWER, 'viewer', roleOf('viewer'));

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
  }

  function sessionOf(code: string, account: Id<'Account'>, n: number) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(0xf600 + n),
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

  const types = '/certification/admin/types';
  const issuers = '/certification/admin/issuers';

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    registry = new MemoryRegistry();
    outbox = new MemoryOutbox();
    logged = [];
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await app?.close();
  });

  it('maps the refusals of the routes to their status', () => {
    expect(ADMIN_REGISTRY_STATUS).toMatchObject({
      'validation.failed': 400,
      'review.second-admin-required': 403,
      'review.not-proposer': 403,
      'type.not-found': 404,
      'issuer.not-found': 404,
      'proposal.not-found': 404,
      'conflict.stale': 409,
      'review.proposal-pending': 409,
      'issuer.confirmation-count-mismatch': 409,
      'type.revision-invalid': 422,
      'issuer.expert-approval-not-new': 422,
    });
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('keeps the protected edit keys out of every default role', async () => {
      await boot();
      await seeded(code);
      const seeded_ = [...fakes.roles.values()].filter(
        (r) => r.marketId === code && r.kind !== 'custom',
      );
      expect(seeded_.length).toBeGreaterThan(0);
      for (const role of seeded_) {
        expect(role.permissionKeys).not.toContain('certification.type.edit');
        expect(role.permissionKeys).not.toContain('certification.issuer.edit');
      }
      // The Platform Administrator holds every key by its own rule, not by a list.
      const platform = seeded_.filter(
        (r) => r.scope === 'platform' && r.seedCode !== 'platform-administrator',
      );
      for (const role of platform) expect(role.permissionKeys).toContain('certification.type.view');
    }, 30_000);

    it('lets a default role read but not write', async () => {
      await boot();
      await seeded(code);
      const viewer = sessionOf(code, VIEWER, 1);
      const reviewer = sessionOf(code, REVIEWER, 2);
      const list = await http().get(types).set(viewer).expect(200);
      expect(list.headers['cache-control']).toContain('no-store');
      expect(list.body).toMatchObject({ items: [{ typeId: TYPE, code: 'qorvane' }] });
      await http().get(`${types}/${TYPE}`).set(viewer).expect(200);
      await http().get(issuers).set(reviewer).expect(200);
      const refused = await http()
        .post(`${types}/${TYPE}/deactivate`)
        .set(reviewer)
        .send({ version: 1 })
        .expect(403);
      expect(refused.body).toMatchObject({ code: 'access.denied' });
      await http()
        .post(issuers)
        .set(reviewer)
        .send({ typeId: TYPE, displayName: 'Example Certifiers' })
        .expect(403);
      expect(registry.state.issuers.size).toBe(0);
      expect(registry.state.types.get(TYPE)!.status).toBe('active');
    }, 30_000);

    it('walks an issuer through both forms and a two-admin reactivation (AC 19, H1)', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 3);
      const b = sessionOf(code, EDITOR_B, 4);

      const created = await http()
        .post(issuers)
        .set(a)
        .send({ typeId: TYPE, displayName: 'Example Certifiers' })
        .expect(201);
      const issuerId = (created.body as { issuerId: string }).issuerId;
      expect(created.body).toMatchObject({ state: 'proposed', version: 1 });
      await http()
        .post(`${issuers}/${issuerId}/activate`)
        .set(a)
        .send({ version: 1, expertApproval: { confirmedBy: 'Expert', reference: REFERENCE } })
        .expect(200);
      const reference = await http()
        .get(`${issuers}/${issuerId}/expert-reference`)
        .set(a)
        .expect(200);
      expect(reference.headers['cache-control']).toBe('private, no-store');
      expect(reference.body).toMatchObject({ current: { reference: REFERENCE } });

      await http()
        .post(`${issuers}/${issuerId}/close-to-new`)
        .set(a)
        .send({ version: 2 })
        .expect(200);
      const asked = await http()
        .post(`${issuers}/${issuerId}/reactivation`)
        .set(a)
        .send({ version: 3, expertApproval: { confirmedBy: 'Expert', reference: NEW_REFERENCE } })
        .expect(200);
      const proposalId = (asked.body as { proposalId: string }).proposalId;
      const same = await http()
        .post(`${issuers}/${issuerId}/reactivations/${proposalId}/approve`)
        .set(a)
        .send({ version: 1 })
        .expect(403);
      expect(same.body).toMatchObject({ code: 'review.second-admin-required' });
      const approved = await http()
        .post(`${issuers}/${issuerId}/reactivations/${proposalId}/approve`)
        .set(b)
        .send({ version: 1 })
        .expect(200);
      expect(approved.body).toMatchObject({ state: 'active', issuerVersion: 4 });

      const page = await http().get(`${issuers}/${issuerId}`).set(b).expect(200);
      expect(page.body).toMatchObject({ state: 'active', affectedCertificates: 0 });
      const mismatch = await http()
        .post(`${issuers}/${issuerId}/derecognise`)
        .set(b)
        .send({ version: 4, affectedCertificates: 3 })
        .expect(409);
      expect(mismatch.body).toMatchObject({ code: 'issuer.confirmation-count-mismatch' });
      await http()
        .post(`${issuers}/${issuerId}/derecognise`)
        .set(b)
        .send({ version: 4, affectedCertificates: 0 })
        .expect(200);

      expect(outbox.events.map((e) => [e.type, (e.payload as { form?: string }).form])).toEqual([
        ['certification.issuer-deactivated.v1', 'closed-to-new'],
        ['certification.relaxation-proposed.v1', undefined],
        ['certification.issuer-deactivated.v1', 'derecognised'],
      ]);
      expect(fakes.audits.map((x) => x.action)).toEqual(
        expect.arrayContaining([
          'certification.issuer.created',
          'certification.issuer.activated',
          'certification.issuer.expert-reference-viewed',
          'certification.issuer.closed-to-new',
          'certification.issuer.reactivation-requested',
          'certification.issuer.reactivation-approved',
          'certification.issuer.derecognised',
        ]),
      );
      const everything = JSON.stringify({ logged, events: outbox.events, audits: fakes.audits });
      expect(everything).not.toContain('Canary-Memo');
    }, 30_000);

    it('deactivates a type and reactivates it with a second editor (H1)', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 5);
      const b = sessionOf(code, EDITOR_B, 6);
      await http().post(`${types}/${TYPE}/deactivate`).set(a).send({ version: 1 }).expect(200);
      const asked = await http()
        .post(`${types}/${TYPE}/reactivation`)
        .set(a)
        .send({ version: 2, reason: 'Back in use' })
        .expect(200);
      const proposalId = (asked.body as { proposalId: string }).proposalId;
      await http()
        .post(`${types}/${TYPE}/reactivations/${proposalId}/approve`)
        .set(a)
        .send({ version: 1 })
        .expect(403);
      // Only the requester withdraws.
      await http()
        .post(`${types}/${TYPE}/proposals/${proposalId}/withdraw`)
        .set(b)
        .send({ version: 1 })
        .expect(403);
      const approved = await http()
        .post(`${types}/${TYPE}/reactivations/${proposalId}/approve`)
        .set(b)
        .send({ version: 1 })
        .expect(200);
      expect(approved.body).toMatchObject({ status: 'active', typeVersion: 3 });
      expect(outbox.events.map((e) => e.type)).toEqual([
        'certification.certification-type-deactivated.v1',
        'certification.relaxation-proposed.v1',
        'certification.certification-type-activated.v1',
      ]);
    }, 30_000);

    it('takes a closed JSON body with the CSRF token only', async () => {
      await boot();
      await seeded(code);
      const a = sessionOf(code, EDITOR_A, 7);
      const noCsrf: Partial<typeof a> = { ...a };
      delete noCsrf['x-csrf-token'];
      await http().post(`${types}/${TYPE}/deactivate`).set(noCsrf).send({ version: 1 }).expect(403);
      const unknown = await http()
        .post(`${types}/${TYPE}/deactivate`)
        .set(a)
        .send({ version: 1, status: 'inactive' })
        .expect(400);
      expect(unknown.body).toMatchObject({ code: 'validation.failed' });
      await http()
        .post(`${types}/${TYPE}/deactivate`)
        .set(a)
        .set('content-type', 'text/plain')
        .send('version=1')
        .expect(415);
      await http().get(`${types}/not-an-id`).set(a).expect(400);
      expect(registry.state.types.get(TYPE)!.status).toBe('active');
    }, 30_000);
  });
});
