import type { NestExpressApplication } from '@nestjs/platform-express';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import request from 'supertest';
import { SeedRoles } from '../src/modules/identity/application/use-cases/seed-roles.use-case';
import type { AccountState } from '../src/modules/identity/domain/account';
import { openSession } from '../src/modules/identity/domain/session';
import { RandomSessionTokens } from '../src/modules/identity/infrastructure/sessions/random-session-tokens';
import { BUSINESS_FILE_REVISION_REPOSITORY } from '../src/modules/sellers/application/ports/business-file-revision.repository';
import { REGISTER_CHECK_REPOSITORY } from '../src/modules/sellers/application/ports/register-check.repository';
import { REVISION_CONTENT_SEALER } from '../src/modules/sellers/application/ports/revision-content-sealer';
import { SELLER_ACCESS_READER } from '../src/modules/sellers/application/ports/seller-access-reader';
import { SELLER_FILE_REPOSITORY } from '../src/modules/sellers/application/ports/seller-file.repository';
import { ADMIN_FLAG_REPOSITORY } from '../src/modules/sellers/application/ports/admin-flag.repository';
import { IDENTIFIER_CLAIM_REPOSITORY } from '../src/modules/sellers/application/ports/identifier-claim.repository';
import { REVIEW_CHECK_REPOSITORY } from '../src/modules/sellers/application/ports/review-check.repository';
import { SELLER_ACCESS_DECIDER } from '../src/modules/sellers/application/ports/seller-access-decider';
import { SHOP_SLUG_REPOSITORY } from '../src/modules/sellers/application/ports/shop-slug.repository';
import { parseStoreName } from '../src/modules/sellers/domain/store-name';
import {
  newPendingRevision,
  type BusinessFileContent,
} from '../src/modules/sellers/domain/business-file-revision';
import { SellerFile } from '../src/modules/sellers/domain/seller-file';
import { csrfTokenFor } from '../src/platform/call-context/csrf';
import { CLOCK } from '../src/platform/clock/clock.module';
import { PLATFORM_TENANT_ID } from '../src/platform/market-context/tenant';
import { fakeHashOf, IdentityFakes } from './support/identity-fakes';
import { InMemoryRegisterChecks } from './support/sellers-register-fakes';
import {
  FakeAccess,
  FakeDecider,
  FakeSealer,
  InMemoryClaims,
  InMemoryFiles,
  InMemoryFlags,
  InMemoryReviewChecks,
  InMemoryRevisions,
  InMemorySlugs,
} from './support/sellers-submit-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The reviewer's decision over HTTP (sellers design 3.1, 6.2, 7.3, 8.3; slice 7a-decide): approve,
// reject and the manual register check under `/sellers/admin/:sellerId/review/…`, with the real
// guards, CSRF and origin checks, controller, gate, default roles and use cases on both Market
// fixtures. `identity`'s decision is the scripted fake decider (identity's own side of the contract
// has its own suites); the sellers stores are in-memory fakes (their SQL is covered by the db specs).

const START = Temporal.Instant.from('2026-10-09T10:00:00Z');
const LIFETIME = { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 };

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const accountId = (n: number) => id<'Account'>(`01990000-0000-7000-8000-${n12(0xb000 + n)}`);
const SELLER = id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc001)}`);
const ROOT = accountId(1);
const VIEWER = accountId(2);
const CUSTOMER = accountId(3);
const COMPLIANCE = accountId(4);
const MODERATOR = accountId(5);

const CONTENT: BusinessFileContent = {
  schemaVersion: 1,
  storeName: 'Al Noor Grocer',
  businessName: 'Al Noor Pty Ltd',
  phone: '+61 7 3000 0000',
  contactEmail: 'shop@example.com',
  address: { line1: '1 George St', suburb: 'Brisbane' },
  registeredAddress: null,
  identifier: { scheme: 'abn', value: '51824753556' },
  registeredForIndirectTax: true,
};

const fakes = new IdentityFakes();
const tokens = new RandomSessionTokens();
let clock: FixedClock;

describe('the reviewer decision over HTTP (integration, slice 7a-decide)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let files: InMemoryFiles;
  let revisions: InMemoryRevisions;
  let access: FakeAccess;
  let decider: FakeDecider;
  let reviewChecks: InMemoryReviewChecks;
  const sealer = new FakeSealer();
  const checks = new InMemoryRegisterChecks();
  const http = () => request(app.getHttpServer());

  async function boot() {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info' },
      panelOrigins: true,
      override: (builder) =>
        fakes
          .override(builder)
          .overrideProvider(CLOCK)
          .useValue(clock)
          .overrideProvider(SELLER_FILE_REPOSITORY)
          .useValue(files)
          .overrideProvider(BUSINESS_FILE_REVISION_REPOSITORY)
          .useValue(revisions)
          .overrideProvider(REVISION_CONTENT_SEALER)
          .useValue(sealer)
          .overrideProvider(REGISTER_CHECK_REPOSITORY)
          .useValue(checks)
          .overrideProvider(SELLER_ACCESS_READER)
          .useValue(access)
          .overrideProvider(SELLER_ACCESS_DECIDER)
          .useValue(decider)
          .overrideProvider(REVIEW_CHECK_REPOSITORY)
          .useValue(reviewChecks)
          .overrideProvider(IDENTIFIER_CLAIM_REPOSITORY)
          .useValue(new InMemoryClaims())
          .overrideProvider(ADMIN_FLAG_REPOSITORY)
          .useValue(new InMemoryFlags())
          .overrideProvider(SHOP_SLUG_REPOSITORY)
          .useValue(new InMemorySlugs()),
    }));
  }

  const marketOf = (code: string) => testMarketContext(code, PLATFORM_TENANT_ID);
  const roleOf = (code: string, seedCode: string) =>
    [...fakes.roles.values()].find(
      (r) => r.marketId === code && r.scope === 'platform' && r.seedCode === seedCode,
    )!.id;

  async function seeded(code: string) {
    await app.get(SeedRoles).execute(testCallContext(marketOf(code), 'system', 'review-0001'), {});
    const marketId = code as AccountState['marketId'];
    const account = (n: number, idOf: Id<'Account'>, population: AccountState['population']) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `Person${n}@Example.com`, normalized: `person${n}@example.com` },
        displayName: population === 'customer' ? null : `Person ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    const admin = (n: number, idOf: Id<'Account'>, seedCode: string) => {
      account(n, idOf, 'admin');
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe200 + n)}`),
        marketId,
        accountId: idOf,
        roleId: roleOf(code, seedCode),
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    };
    admin(1, ROOT, 'platform-administrator');
    admin(2, VIEWER, 'viewer');
    admin(4, COMPLIANCE, 'onboarding-compliance');
    admin(5, MODERATOR, 'catalogue-moderator');
    account(3, CUSTOMER, 'customer');

    // One seller of this Market with a pending onboarding revision.
    const created = SellerFile.create({
      sellerId: SELLER,
      marketId,
      origin: 'self',
      approvalRequiredAtRegistration: true,
      now: START,
    });
    const storeName = parseStoreName(CONTENT.storeName);
    if (!storeName.ok) throw new Error('store name');
    files.add(
      SellerFile.restore({
        ...created.state,
        draft: { ...created.state.draft, storeName: storeName.value },
      }),
    );
    const sealed = await sealer.seal(marketOf(code), SELLER, CONTENT);
    if (!sealed.ok) throw new Error('seal');
    await revisions.add(
      marketOf(code),
      newPendingRevision({
        id: id<'BusinessFileRevision'>(`01990000-0000-7000-8000-${n12(0xd001)}`),
        sellerId: SELLER,
        kind: 'onboarding',
        revisionNo: 1,
        authorKind: 'seller',
        authorAccountId: accountId(9),
        snapshot: {
          operatingTimezone: 'Australia/Brisbane',
          serviceAreaCode: 'open',
          addressTimezone: 'Australia/Brisbane',
          identifierIndex: null,
        },
        contentHash: sealed.value.contentHash,
        register: { outcome: 'not-performed', mismatches: [], checkedAt: null },
        now: START,
      }),
      sealed.value,
    );
    access.set(SELLER, 'pending');
  }

  function sessionHeaders(
    code: string,
    account: Id<'Account'>,
    n: number,
    population: 'admin' | 'customer' = 'admin',
  ) {
    const issued = tokens.issue();
    void fakes.sessionRepository.add(
      marketOf(code),
      openSession({
        id: id<'Session'>(`01990000-0000-7000-8000-${n12(0xf200 + n)}`),
        marketId: code as AccountState['marketId'],
        accountId: account,
        population,
        transport: 'cookie',
        lifetime: LIFETIME,
        now: clock.now(),
      }),
      issued.tokenHash,
    );
    return {
      cookie: `__Host-session-${population}-${code}=${issued.token}`,
      'x-csrf-token': csrfTokenFor(issued.token),
    };
  }

  const REVISION = `01990000-0000-7000-8000-${n12(0xd001)}`;
  const REASON = 'The licence number does not match';
  const send = (
    method: 'post' | 'put',
    code: string,
    path: string,
    body: unknown,
    headers: Record<string, string> | null,
  ) => {
    const call = http()
      [method](`/sellers/admin/${SELLER}/review/${path}`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    if (headers !== null) call.set(headers);
    return call.send(body as object);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    files = new InMemoryFiles();
    revisions = new InMemoryRevisions();
    access = new FakeAccess();
    decider = new FakeDecider();
    reviewChecks = new InMemoryReviewChecks();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the routes in OpenAPI', async () => {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };

    for (const path of ['approve', 'reject', 'manual-register-check']) {
      expect(document.paths[`/sellers/admin/{sellerId}/review/${path}`]).toBeDefined();
    }
    expect(document.components.schemas).toHaveProperty(['ReviewDecidedBody']);
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lets the platform administrator approve, no-store, with the revision id', async () => {
      await boot();
      await seeded(code);

      const approved = await send(
        'post',
        code,
        'approve',
        { revisionId: REVISION },
        sessionHeaders(code, ROOT, 1),
      );

      expect(approved.status).toBe(200);
      expect(approved.headers['cache-control']).toBe('no-store');
      expect(approved.body).toEqual({ decision: 'approved', revisionId: REVISION });
      expect(decider.calls).toEqual([{ kind: 'approve', sellerId: SELLER, basisId: REVISION }]);
      expect((await revisions.findById(marketOf(code), SELLER, REVISION as never))?.status).toBe(
        'approved',
      );
    });

    it('lets the Onboarding and Compliance role reject; the reason is never logged', async () => {
      await boot();
      await seeded(code);

      const rejected = await send(
        'post',
        code,
        'reject',
        { revisionId: REVISION, reason: REASON },
        sessionHeaders(code, COMPLIANCE, 2),
      );

      expect(rejected.status).toBe(200);
      expect(rejected.body).toEqual({ decision: 'rejected', revisionId: REVISION });
      expect(logLines.some((l) => l.msg === 'sellers.review-reject')).toBe(true);
      expect(JSON.stringify(logLines)).not.toContain('licence');
    });

    it('answers 202 in-progress when identity does not answer in time', async () => {
      await boot();
      await seeded(code);
      decider.script.push('throw');

      const pending = await send(
        'post',
        code,
        'approve',
        { revisionId: REVISION },
        sessionHeaders(code, ROOT, 3),
      );

      expect(pending.status).toBe(202);
      expect(pending.body).toEqual({ decision: 'in-progress', revisionId: REVISION });
      const again = await send(
        'post',
        code,
        'reject',
        { revisionId: REVISION, reason: REASON },
        sessionHeaders(code, ROOT, 4),
      );
      expect(again.status).toBe(409);
      expect(again.body).toEqual({ statusCode: 409, code: 'file.decision-in-progress' });
    });

    it('records a manual register check, audited', async () => {
      await boot();
      await seeded(code);

      const recorded = await send(
        'put',
        code,
        'manual-register-check',
        { revisionId: REVISION, observedOutcome: 'active' },
        sessionHeaders(code, COMPLIANCE, 5),
      );

      expect(recorded.status).toBe(200);
      expect(recorded.body).toEqual({ revisionId: REVISION, observedOutcome: 'active' });
      expect(
        fakes.audits.filter((a) => a.action === 'sellers.register.manual-check-recorded'),
      ).toEqual([
        expect.objectContaining({ actor: 'authenticated', marketId: code, targetId: SELLER }),
      ]);
    });

    it('refuses a visitor, the Viewer and the Catalogue Moderator, a request without CSRF, and a bad body', async () => {
      await boot();
      await seeded(code);
      const body = { revisionId: REVISION };

      expect((await send('post', code, 'approve', body, null)).status).toBe(401);
      const viewer = await send('post', code, 'approve', body, sessionHeaders(code, VIEWER, 6));
      expect(viewer.body).toEqual({ statusCode: 403, code: 'access.denied' });
      const moderator = await send(
        'put',
        code,
        'manual-register-check',
        { ...body, observedOutcome: 'active' },
        sessionHeaders(code, MODERATOR, 7),
      );
      expect(moderator.body).toEqual({ statusCode: 403, code: 'access.denied' });
      const noCsrf = await send('post', code, 'approve', body, {
        ...sessionHeaders(code, ROOT, 8),
        'x-csrf-token': '',
      });
      expect(noCsrf.body).toEqual({ statusCode: 403, code: 'request.csrf' });
      const extra = await send(
        'post',
        code,
        'approve',
        { ...body, extra: 1 },
        sessionHeaders(code, ROOT, 9),
      );
      expect(extra.status).toBe(400);
      expect(extra.body).toMatchObject({ code: 'validation.failed' });
      const wrong = await send(
        'post',
        code,
        'approve',
        { revisionId: `01990000-0000-7000-8000-${n12(0xd999)}` },
        sessionHeaders(code, ROOT, 10),
      );
      expect(wrong.body).toEqual({ statusCode: 409, code: 'review.not-current-revision' });
      expect(decider.calls).toEqual([]);
    });
  });
});
