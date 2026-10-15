import { randomBytes, randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { SellerAccess } from '../../src/modules/identity/domain/seller-access';
import { Invitation } from '../../src/modules/identity/domain/invitation';
import { parseEmailAddress } from '../../src/modules/identity/domain/email-address';
import {
  INVITATION_REPOSITORY,
  type InvitationRepository,
} from '../../src/modules/identity/application/ports/invitation.repository';
import {
  INVITATION_TOKENS,
  type OpaqueTokens,
} from '../../src/modules/identity/application/ports/second-factor-tokens';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../src/modules/identity/application/ports/seller-access.repository';
import { AcceptSellerInvitation } from '../../src/modules/identity/application/use-cases/accept-seller-invitation.use-case';
import { ConfirmSellerSecondFactorReset } from '../../src/modules/identity/application/use-cases/confirm-seller-second-factor-reset.use-case';
import { SeedRoles } from '../../src/modules/identity/application/use-cases/seed-roles.use-case';
import { StartSellerOwnerSecondFactorReset } from '../../src/modules/identity/application/use-cases/start-seller-owner-second-factor-reset.use-case';
import { CLOCK } from '../../src/platform/clock/clock.module';
import {
  IDENTITY_MARKET_POLICY,
  type IdentityMarketPolicy,
} from '../../src/modules/identity/application/ports/identity-market-policy';
import {
  LINK_TOKENS,
  type LinkTokens,
} from '../../src/modules/identity/application/ports/link-secrets';
import {
  ONE_TIME_LINK_REPOSITORY,
  type OneTimeLinkRepository,
} from '../../src/modules/identity/application/ports/one-time-link.repository';
import { TransactionConflictError } from '../../src/platform/unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf, otherMarketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The owner-confirmed reset of a Seller Owner's second factor on PostgreSQL (identity design 3.7,
// 7.3; slice 12), for both Market fixtures: the real use cases, repositories, outbox and link mail
// handler. An admin starts the reset (the link row only: nothing is removed), the owner's link is
// mailed and stored, and the confirmation removes the factor, its codes and the open challenges in
// one unit, once; a second use, an expired link, another Market, a demoted owner and two racing
// confirmations are refused or serialised.

const PASSWORD = 'correct horse battery staple';
const PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn';
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;
const CLIENT = { origin: '203.0.113.7', address: '203.0.113.7' };

/**
 * Seeding only: under parallel jest workers a SERIALIZABLE unit can lose all of its own retries
 * (TransactionConflictError, 40001) to unrelated suites' load. The unit rolled back, so running the
 * same seeding step again is safe. Bounded, and any other error or the last conflict is rethrown;
 * the assertions of the specs are untouched.
 */
const SEED_ATTEMPTS = 5;
async function retryingSeed<T>(seed: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await seed();
    } catch (error) {
      if (!(error instanceof TransactionConflictError) || attempt >= SEED_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
}

describe.each(TEST_MARKETS)(
  'owner-confirmed second-factor reset in market %s (database, slice 12)',
  (code) => {
    const market = marketOf(code);
    const otherMarket = marketOf(otherMarketOf(code));
    const clock = new FixedClock(Temporal.Now.instant());
    let app: NestExpressApplication;
    let sql: Client;
    let unitOfWork: UnitOfWork;
    let invitations: InvitationRepository;
    let sellers: SellerAccessRepository;
    let tokens: OpaqueTokens;
    let linkTokens: LinkTokens;
    let links: OneTimeLinkRepository;
    let policy: IdentityMarketPolicy;
    let logs: jest.SpyInstance[];

    beforeAll(async () => {
      ({ app } = await createTestApp({
        env: { DATABASE_URL: testDatabaseUrl() },
        override: (builder) => builder.overrideProvider(CLOCK).useValue(clock),
      }));
      sql = new Client({ connectionString: testDatabaseUrl() });
      await sql.connect();
      unitOfWork = app.get(UNIT_OF_WORK, { strict: false });
      invitations = app.get(INVITATION_REPOSITORY, { strict: false });
      sellers = app.get(SELLER_ACCESS_REPOSITORY, { strict: false });
      tokens = app.get(INVITATION_TOKENS, { strict: false });
      linkTokens = app.get(LINK_TOKENS, { strict: false });
      links = app.get(ONE_TIME_LINK_REPOSITORY, { strict: false });
      policy = app.get(IDENTITY_MARKET_POLICY, { strict: false });
      for (const m of [market, otherMarket]) {
        await app
          .get(SeedRoles)
          .execute(testCallContext(m, 'system', `db-reset-${randomUUID()}`), {});
      }
    });
    afterAll(async () => {
      await sql.end();
      await app.close();
    });
    beforeEach(() => {
      logs = (['log', 'warn', 'error', 'debug'] as const).map((level) =>
        jest.spyOn(Logger.prototype, level).mockImplementation(() => undefined),
      );
    });
    afterEach(() => logs.forEach((spy) => spy.mockRestore()));

    const inUnit = <T>(m: MarketContext, work: () => Promise<T>): Promise<T> =>
      unitOfWork
        .run(m, async () => ok(await work()))
        .then((r) => (r as { ok: true; value: T }).value);

    const roleId = async (scope: string, seedCode: string): Promise<Id<'Role'>> => {
      const { rows } = await sql.query<{ id: Id<'Role'> }>(
        `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = $2 AND seed_code = $3`,
        [code, scope, seedCode],
      );
      return rows[0]!.id;
    };

    /** An active, verified admin of the default role `seedCode`. */
    async function admin(seedCode: string): Promise<Id<'Account'>> {
      const id = newId<'Account'>();
      const email = `admin.${id}@reset.example`;
      await sql.query(
        `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
         email_normalized, display_name, status, email_verified_at, signed_up_at, version,
         created_at)
         VALUES ($1, $2, 'default', 'admin', $3, $3, 'Admin', 'active', now(), now(), 1, now())`,
        [id, code, email],
      );
      await sql.query(
        `INSERT INTO identity.password_credentials
           (market_id, tenant_id, account_id, password_hash, changed_at)
         VALUES ($1, 'default', $2, $3, now())`,
        [code, id, PASSWORD_HASH],
      );
      await sql.query(
        `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
         assigned_by_account_id, assigned_at, version)
         VALUES ($1, $2, 'default', $3, $4, NULL, now(), 1)`,
        [newId(), code, id, await roleId('platform', seedCode)],
      );
      return id;
    }

    /** A seller with its owner account (an accepted invitation) and an active second factor. */
    async function ownerWithFactor() {
      const email = `owner.${randomUUID()}@reset.example`;
      const inviterId = await admin('onboarding-compliance');
      const now = clock.now();
      const access = SellerAccess.forInvitation({
        sellerId: newId<'Seller'>(),
        marketId: market.marketId,
        approvalRequired: true,
        now,
      });
      const parsed = parseEmailAddress(email);
      if (!parsed.ok) throw new Error('fixture address');
      const invitation = Invitation.issue({
        id: newId<'Invitation'>(),
        marketId: market.marketId,
        kind: 'seller-owner',
        email: parsed.value,
        displayName: 'Amina Rahman',
        roleId: await roleId('seller', 'seller-owner'),
        sellerId: access.state.sellerId,
        invitedByAccountId: inviterId,
        now,
      });
      await inUnit(market, async () => {
        await sellers.add(market, access);
        await invitations.add(market, invitation);
      });
      const issued = tokens.issue();
      await inUnit(market, async () => {
        const stored = (await invitations.findById(market, invitation.state.id))!;
        if (!stored.dispatch(issued.tokenHash, now, 60).ok) throw new Error('dispatch');
        await invitations.save(market, stored);
      });
      const accepted = await retryingSeed(() =>
        app.get(AcceptSellerInvitation).execute(testCallContext(market, 'anonymous'), {
          token: issued.token,
          password: PASSWORD,
          client: CLIENT,
        }),
      );
      if (!accepted.ok) throw new Error(`acceptance failed: ${accepted.error.code}`);
      const accountId = (
        await sql.query<{ id: Id<'Account'> }>(
          `SELECT id FROM identity.accounts WHERE market_id = $1 AND email_normalized = $2`,
          [code, email],
        )
      ).rows[0]!.id;
      await insertFactorAndChallenge(accountId);
      return { sellerId: access.state.sellerId, accountId, email };
    }

    async function insertFactorAndChallenge(accountId: Id<'Account'>) {
      const now = new Date(clock.now().epochMilliseconds);
      const expires = new Date(clock.now().add({ minutes: 5 }).epochMilliseconds);
      await sql.query(
        `INSERT INTO identity.sign_in_challenges (id, market_id, tenant_id, account_id, purpose,
           token_hash, attempts, credential_changed_at, expires_at, consumed_at, created_at)
         VALUES ($1, $2, 'default', $3, 'second-factor', $4, 0, $5, $6, NULL, $5)`,
        [uuidV7(Date.now(), randomBytes(10)), code, accountId, randomBytes(32), now, expires],
      );
      const factorId = uuidV7(Date.now(), randomBytes(10));
      await sql.query(
        `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id, state,
           secret_ciphertext, last_accepted_step, activated_at, created_at, version)
         VALUES ($1, $2, 'default', $3, 'active', 'ciphertext', NULL, $4, $4, 1)`,
        [factorId, code, accountId, now],
      );
      for (let position = 1; position <= 10; position += 1) {
        await sql.query(
          `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id, position,
             code_hash) VALUES ($1, 'default', $2, $3, $4)`,
          [code, factorId, position, randomBytes(32)],
        );
      }
    }

    const asAdmin = (accountId: Id<'Account'>) =>
      testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId,
          sessionId: newId<'Session'>(),
          sellerId: null,
        }),
        `db-reset-start-${randomUUID()}`,
      );

    const start = (accountId: Id<'Account'>, sellerId: Id<'Seller'>) =>
      app.get(StartSellerOwnerSecondFactorReset).execute(asAdmin(accountId), {
        sellerId,
        origin: `198.51.100.${Math.floor(Math.random() * 250) + 1}`,
      });

    /**
     * Stands in for the mail handler, as the invitation spec does for its dispatch: the delivery
     * cannot be handed out outside the dispatcher, whose relay would also carry other specs'
     * events on this shared database. Stores the hash of a new token on the requested link, with
     * the Market's lifetime; answers the token. The mail's own text is covered in the HTTP spec.
     */
    async function mailed(accountId: Id<'Account'>): Promise<string> {
      const issued = linkTokens.issue();
      await inUnit(market, async () => {
        const link = (await links.findFor(market, accountId, 'confirm-second-factor-reset'))!;
        const lifetime = policy.linkLifetimeMinutes(market, 'confirm-second-factor-reset');
        if (lifetime === null || !link.issue(issued.tokenHash, clock.now(), lifetime).ok) {
          throw new Error('issue');
        }
        await links.save(market, link);
      });
      return issued.token;
    }

    const confirm = (token: string, m: MarketContext = market) =>
      app.get(ConfirmSellerSecondFactorReset).execute(testCallContext(m, 'anonymous'), {
        token,
        client: {
          origin: `203.0.113.${Math.floor(Math.random() * 250) + 1}`,
          address: CLIENT.address,
        },
      });

    const factorCount = async (accountId: string) =>
      Number(
        (
          await sql.query<{ n: string }>(
            `SELECT count(*) AS n FROM identity.second_factors WHERE market_id = $1 AND account_id = $2`,
            [code, accountId],
          )
        ).rows[0]!.n,
      );

    it('starts without removing anything, stores the link, and removes the factor once on confirmation', async () => {
      const root = await admin('operations-support');
      const owner = await ownerWithFactor();

      const started = await start(root, owner.sellerId);
      expect(started).toMatchObject({ ok: true, value: { code: 'second-factor-reset.requested' } });
      expect(await factorCount(owner.accountId)).toBe(1);
      const token = await mailed(owner.accountId);
      expect(await factorCount(owner.accountId)).toBe(1);

      const factorId = (
        await sql.query<{ id: string }>(
          `SELECT id FROM identity.second_factors WHERE market_id = $1 AND account_id = $2`,
          [code, owner.accountId],
        )
      ).rows[0]!.id;
      const confirmed = await confirm(token);
      expect(confirmed).toMatchObject({ ok: true, value: { code: 'second-factor.reset' } });
      expect(await factorCount(owner.accountId)).toBe(0);
      const codes = await sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM identity.recovery_codes WHERE market_id = $1
           AND second_factor_id = $2`,
        [code, factorId],
      );
      expect(codes.rows[0]!.n).toBe('0');
      const challenges = await sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM identity.sign_in_challenges
         WHERE market_id = $1 AND account_id = $2 AND consumed_at IS NULL`,
        [code, owner.accountId],
      );
      expect(challenges.rows[0]!.n).toBe('0');
      const audits = await sql.query<{ action: string; actor_type: string }>(
        `SELECT action, actor_type FROM platform.audit_log
         WHERE market_id = $1 AND action LIKE 'identity.seller-second-factor-reset.%'
           AND target_id = $2
         ORDER BY occurred_at`,
        [code, owner.accountId],
      );
      expect(audits.rows).toEqual([
        { action: 'identity.seller-second-factor-reset.requested', actor_type: 'USER' },
      ]);
      const confirmedAudit = await sql.query<{ actor_type: string }>(
        `SELECT actor_type FROM platform.audit_log
         WHERE market_id = $1 AND action = 'identity.seller-second-factor-reset.confirmed'
           AND target_id = $2`,
        [code, factorId],
      );
      expect(confirmedAudit.rows[0]).toEqual({ actor_type: 'ANONYMOUS' });
      const changed = await sql.query<{ payload: { change: string } }>(
        `SELECT payload FROM identity.outbox
         WHERE market_id = $1 AND type = 'identity.second-factor-changed.v1'
           AND payload->>'accountId' = $2`,
        [code, owner.accountId],
      );
      expect(changed.rows.map((r) => r.payload.change)).toEqual(['reset']);

      const again = await confirm(token);
      expect(again).toEqual({ ok: false, error: { code: 'link.rejected' } });
    });

    it('refuses an expired link and a token of another Market, and keeps the factor', async () => {
      const root = await admin('operations-support');
      const owner = await ownerWithFactor();
      await start(root, owner.sellerId);
      const token = await mailed(owner.accountId);

      const wrongMarket = await confirm(token, otherMarket);
      expect(wrongMarket).toEqual({ ok: false, error: { code: 'link.rejected' } });
      clock.advance(Temporal.Duration.from({ hours: 25 }));
      const expired = await confirm(token);
      expect(expired).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(await factorCount(owner.accountId)).toBe(1);
    });

    it('refuses an owner that was demoted after the mail, and an admin without the permission', async () => {
      const root = await admin('operations-support');
      const viewer = await admin('viewer');
      const owner = await ownerWithFactor();

      const denied = await start(viewer, owner.sellerId);
      expect(denied).toMatchObject({ ok: false, error: { code: 'access.denied' } });

      await start(root, owner.sellerId);
      const token = await mailed(owner.accountId);
      await sql.query(
        `DELETE FROM identity.role_assignments WHERE market_id = $1 AND account_id = $2`,
        [code, owner.accountId],
      );
      const refused = await confirm(token);
      expect(refused).toEqual({ ok: false, error: { code: 'link.rejected' } });
      expect(await factorCount(owner.accountId)).toBe(1);
    });

    it('lets exactly one of two parallel confirmations remove the factor', async () => {
      const root = await admin('operations-support');
      const owner = await ownerWithFactor();
      await start(root, owner.sellerId);
      const token = await mailed(owner.accountId);

      const results = await Promise.all([confirm(token), confirm(token)]);

      const outcomes = results.map((r) => (r.ok ? r.value.code : r.error.code)).sort();
      expect(outcomes).toEqual(['link.rejected', 'second-factor.reset']);
      expect(await factorCount(owner.accountId)).toBe(0);
    });
  },
);
