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
import { REVIEW_CHECK_REPOSITORY } from '../src/modules/sellers/application/ports/review-check.repository';
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
  FakeSealer,
  InMemoryFiles,
  InMemoryReviewChecks,
  InMemoryRevisions,
} from './support/sellers-submit-fakes';
import { createTestApp, type LogLine } from './support/test-app';
import { panelHeaders, TEST_MARKETS } from './support/test-config';

// The review page over HTTP (sellers design 6.2, 8.3, 9; slice 7a-read): `GET
// /sellers/admin/:sellerId/review` with the real guards, controller, gate, default roles and use
// case on both Market fixtures. Identity's database ports and the sellers stores are in-memory
// fakes (their SQL is covered by the persistence specs); the audit writer is the recording fake,
// so the row of a read is visible here.

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

describe('the review page over HTTP (integration, slice 7a-read)', () => {
  let app: NestExpressApplication;
  let logLines: LogLine[];
  let files: InMemoryFiles;
  let revisions: InMemoryRevisions;
  let access: FakeAccess;
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
          .overrideProvider(REVIEW_CHECK_REPOSITORY)
          .useValue(new InMemoryReviewChecks()),
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
    files.add(
      SellerFile.create({
        sellerId: SELLER,
        marketId,
        origin: 'self',
        approvalRequiredAtRegistration: true,
        now: START,
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

  const get = (code: string, headers: Record<string, string> | null, seller: string = SELLER) => {
    const call = http()
      .get(`/sellers/admin/${seller}/review`)
      .set({ 'x-market-id': code, ...panelHeaders(code, 'admin') });
    return headers === null ? call : call.set('cookie', headers.cookie!);
  };

  beforeEach(() => {
    fakes.reset();
    clock = new FixedClock(START);
    files = new InMemoryFiles();
    revisions = new InMemoryRevisions();
    access = new FakeAccess();
  });
  afterEach(async () => {
    await app.close();
  });

  it('documents the route and its answer in OpenAPI', async () => {
    ({ app, logLines } = await createTestApp({
      env: { LOG_LEVEL: 'info', API_DOCS_ENABLED: 'true' },
      panelOrigins: true,
      override: (builder) => fakes.override(builder),
    }));

    const document = (await http().get('/docs-json').expect(200)).body as {
      paths: Record<string, unknown>;
      components: { schemas: Record<string, unknown> };
    };

    expect(document.paths['/sellers/admin/{sellerId}/review']).toBeDefined();
    for (const schema of ['ReviewReadBody', 'ReviewRevisionBody', 'ReviewContentBody']) {
      expect(document.components.schemas).toHaveProperty([schema]);
    }
  });

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    it('lets the platform administrator and the Onboarding and Compliance role read, in clear and no-store, and audits each read', async () => {
      await boot();
      await seeded(code);

      const root = await get(code, sessionHeaders(code, ROOT, 1));
      const compliance = await get(code, sessionHeaders(code, COMPLIANCE, 2));

      for (const response of [root, compliance]) {
        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect(root.body).toMatchObject({
        sellerId: SELLER,
        access: 'pending',
        previous: null,
        current: {
          kind: 'onboarding',
          status: 'pending',
          content: { storeName: 'Al Noor Grocer', phone: '+61 7 3000 0000' },
        },
        // The fixture's revision carries no business number: the register guard has nothing to
        // check (slice 7a-decide answers blocksApproval from the approval's own guard).
        register: { blocksApproval: false, manualCheck: null },
        decisionInProgress: false,
      });
      const rows = fakes.audits.filter((a) => a.action === 'sellers.business-details.viewed');
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ actor: 'authenticated', marketId: code, targetId: SELLER });
      expect(JSON.stringify(rows)).not.toContain('Al Noor');
    });

    it('refuses a visitor, a customer session, the Viewer and the Catalogue Moderator; nothing is audited', async () => {
      await boot();
      await seeded(code);

      const visitor = await get(code, null);
      const customer = await get(code, sessionHeaders(code, CUSTOMER, 3, 'customer'));
      const viewer = await get(code, sessionHeaders(code, VIEWER, 4));
      const moderator = await get(code, sessionHeaders(code, MODERATOR, 5));

      expect(visitor.status).toBe(401);
      expect(customer.status).toBe(401);
      expect(viewer.status).toBe(403);
      expect(moderator.status).toBe(403);
      expect(viewer.body).toEqual({ statusCode: 403, code: 'access.denied' });
      expect(fakes.audits.filter((a) => a.action === 'sellers.business-details.viewed')).toEqual(
        [],
      );
    });

    it('answers an unknown id and a malformed id alike', async () => {
      await boot();
      await seeded(code);
      const headers = sessionHeaders(code, ROOT, 6);

      const unknown = await get(code, headers, `01990000-0000-7000-8000-${n12(0xc999)}`);
      const malformed = await get(code, headers, 'not-an-id');

      expect(unknown.status).toBe(404);
      expect(malformed.status).toBe(404);
      expect(malformed.body).toEqual(unknown.body);
      expect(unknown.body).toEqual({ statusCode: 404, code: 'file.not-found' });
      expect(unknown.headers['cache-control']).toBe('no-store');
      expect(malformed.headers['cache-control']).toBe('no-store');
    });

    it('answers a seller of the other Market as unknown', async () => {
      await boot();
      await seeded(code);
      const other = TEST_MARKETS.find((m) => m !== code)!;
      const headers = sessionHeaders(code, ROOT, 8);

      // The same id exists only in the other Market's store: this request's Market has no such file.
      files.add(
        SellerFile.create({
          sellerId: id<'Seller'>(`01990000-0000-7000-8000-${n12(0xc555)}`),
          marketId: other as AccountState['marketId'],
          origin: 'self',
          approvalRequiredAtRegistration: true,
          now: START,
        }),
      );
      const foreign = await get(code, headers, `01990000-0000-7000-8000-${n12(0xc555)}`);

      expect(foreign.status).toBe(404);
      expect(foreign.body).toEqual({ statusCode: 404, code: 'file.not-found' });
    });

    it('logs the outcome only, never a business value', async () => {
      await boot();
      await seeded(code);

      await get(code, sessionHeaders(code, ROOT, 7));

      const logs = JSON.stringify(logLines);
      expect(logs).toContain('sellers.review-read');
      for (const secret of ['Al Noor', '3000 0000', 'example.com', '51824753556', 'George']) {
        expect(logs).not.toContain(secret);
      }
    });
  });
});
