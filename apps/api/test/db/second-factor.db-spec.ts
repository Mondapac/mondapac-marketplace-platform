import { randomBytes } from 'node:crypto';
import { Client } from 'pg';
import { ok, Temporal, uuidV7 } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import type { AccessDeclaration } from '../../src/platform/authz';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { fieldLabel } from '../../src/platform/subject-keys/labels';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { SubjectKeyIntegrityError } from '../../src/platform/subject-keys/subject-key-service';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import {
  AccountAccessReviewers,
  SELLER_ACCESS_APPROVE,
} from '../../src/modules/identity/application/access/account-access-reviewers';
import { AccountAuthorisationCheck } from '../../src/modules/identity/application/access/account-authorisation-check';
import { InvitationAlreadyPendingError } from '../../src/modules/identity/application/ports/invitation.repository';
import { parseEmailAddress } from '../../src/modules/identity/domain/email-address';
import { Invitation } from '../../src/modules/identity/domain/invitation';
import { SecondFactor } from '../../src/modules/identity/domain/second-factor';
import { issueChallenge } from '../../src/modules/identity/domain/sign-in-challenge';
import { candidateSteps, timeStepAt } from '../../src/modules/identity/domain/totp';
import { PrismaInvitationRepository } from '../../src/modules/identity/infrastructure/invitations/prisma-invitation.repository';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import { PrismaReviewerCandidateReader } from '../../src/modules/identity/infrastructure/reviewers/prisma-reviewer-candidate-reader';
import { PrismaRoleGrantReader } from '../../src/modules/identity/infrastructure/roles/prisma-role-grant-reader';
import { PrismaSecondFactorRepository } from '../../src/modules/identity/infrastructure/second-factor/prisma-second-factor.repository';
import { PrismaSignInChallengeRepository } from '../../src/modules/identity/infrastructure/second-factor/prisma-sign-in-challenge.repository';
import { SubjectKeySecondFactorSecrets } from '../../src/modules/identity/infrastructure/second-factor/subject-key-second-factor-secrets';
import { hotp } from '../../src/modules/identity/infrastructure/second-factor/totp';
import { PrismaSellerAccessRepository } from '../../src/modules/identity/infrastructure/sellers/prisma-seller-access.repository';
import { PrismaSellerMembershipRepository } from '../../src/modules/identity/infrastructure/sellers/prisma-seller-team.repository';
import { realEffectiveKeys } from '../support/permission-registry';
import { TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Slice 7a on PostgreSQL, as the application role, for both Market fixtures (data design 3.10;
// identity design 3.4, 3.6, 6.3, 7, 8.7): the CHECKs and keys of the four new tables; the
// second factor stored with its sealed secret and keyed codes; a time step and a recovery code
// accepted once under concurrency; a challenge that never allows more checks than its limit
// (HF1); invitations with their pending keys (M12); the cascade from an account; and the
// reviewer rule of 8.7 with real factors (Hassan M2, L-B), equivalent to the gate.

const CREATED = '2026-10-08T00:00:00Z';
const NOW = Temporal.Instant.from('2026-10-08T10:00:00Z');
const HASH = () => new Uint8Array(randomBytes(32));
/** A fresh UUID v7, the only id shape the subject keys and the domain accept. */
const randomUUID = (): string => uuidV7(Date.now(), randomBytes(10));

const emailOf = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};

describe.each(TEST_MARKETS)('slice 7a stores in market %s (database integration)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(NOW);
  let db: Persistence;
  let sql: Client;
  let subjectKeys: NodeSubjectKeyService;
  let factors: PrismaSecondFactorRepository;
  let challenges: PrismaSignInChallengeRepository;
  let invitations: PrismaInvitationRepository;
  let secrets: SubjectKeySecondFactorSecrets;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    subjectKeys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(db.service, db.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    factors = new PrismaSecondFactorRepository(db.service);
    challenges = new PrismaSignInChallengeRepository(db.service);
    invitations = new PrismaInvitationRepository(db.service);
    secrets = new SubjectKeySecondFactorSecrets(subjectKeys);
  });
  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  const unit = async <T>(work: () => Promise<T>, on: MarketContext = market): Promise<T> => {
    const run = await db.unitOfWork.run(on, async () => ok(await work()));
    if (!run.ok) throw new Error('unit failed');
    return run.value;
  };

  /** An admin account with its subject key, as a sign-up or an acceptance creates it. */
  async function insertAdmin(on: MarketContext = market): Promise<Id<'Account'>> {
    const id = randomUUID();
    const email = `Admin.${id}@Example.test`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'admin', $3, $4, 'Admin', 'active', $5, $5, 1, $5)`,
      [id, on.marketId, email, email.toLowerCase(), CREATED],
    );
    // Every stored account has one password credential (data design 5).
    await sql.query(
      `INSERT INTO identity.password_credentials
         (market_id, tenant_id, account_id, password_hash, changed_at)
       VALUES ($1, 'default', $2, $3, $4)`,
      [on.marketId, id, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFn', CREATED],
    );
    await unit(() => subjectKeys.createKey(on, id as Id), on);
    return id as Id<'Account'>;
  }

  /** An active factor with a real sealed secret and real keyed codes. */
  async function enrol(accountId: Id<'Account'>, step = 100) {
    const secret = secrets.newSecret();
    const codes = secrets.newRecoveryCodes();
    const factor = await unit(async () => {
      const hashes = [];
      for (const c of codes) hashes.push(await secrets.recoveryCodeHash(market, accountId, c));
      const created = SecondFactor.createActive({
        id: randomUUID() as Id<'SecondFactor'>,
        marketId: market.marketId,
        accountId,
        secretCiphertext: await secrets.seal(market, accountId, secret),
        acceptedStep: step,
        recoveryCodeHashes: hashes,
        now: NOW,
      });
      await factors.add(market, created);
      return created;
    });
    return { secret, codes, factor };
  }

  async function violated(text: string, params: unknown[]): Promise<string | null> {
    try {
      await sql.query(text, params);
      return null;
    } catch (error) {
      return (error as { constraint?: string }).constraint ?? 'no-constraint';
    }
  }

  describe('the CHECKs and keys of data design 3.10', () => {
    const factorRow = `INSERT INTO identity.second_factors (id, market_id, tenant_id, account_id,
      state, secret_ciphertext, pending_secret_ciphertext, last_accepted_step, activated_at,
      created_at, version) VALUES ($1, $2, 'default', $3, $4, 'c', $5, $6, $7, $8, 1)`;

    it('refuses a broken factor, a second one for the account and one in another Market', async () => {
      const account = await insertAdmin();
      const row = (overrides: Partial<Record<string, unknown>> = {}) => [
        randomUUID(),
        overrides.market ?? code,
        account,
        overrides.state ?? 'active',
        overrides.pending ?? null,
        overrides.step ?? 1,
        'activated' in overrides ? overrides.activated : CREATED,
        CREATED,
      ];
      expect(await violated(factorRow, row({ activated: null }))).toBe(
        'second_factors_activated_check',
      );
      expect(
        await violated(factorRow, row({ state: 'pending', pending: 'p', activated: null })),
      ).toBe('second_factors_pending_secret_check');
      expect(await violated(factorRow, row({ state: 'off', activated: null }))).toBe(
        'second_factors_state_check',
      );
      expect(await violated(factorRow, row({ step: -1 }))).toBe(
        'second_factors_last_accepted_step_check',
      );
      expect(await violated(factorRow, row({ market: otherMarketOf(code) }))).toBe(
        'second_factors_market_id_account_id_fkey',
      );
      expect(await violated(factorRow, row())).toBeNull();
      expect(await violated(factorRow, row())).toBe('second_factors_market_id_account_id_key');
    });

    it('holds at most ten recovery codes of 32 bytes', async () => {
      const { factor } = await enrol(await insertAdmin());
      const codeRow = `INSERT INTO identity.recovery_codes (market_id, tenant_id, second_factor_id,
        position, code_hash) VALUES ($1, 'default', $2, $3, $4)`;
      expect(await violated(codeRow, [code, factor.state.id, 11, Buffer.alloc(32)])).toBe(
        'recovery_codes_position_check',
      );
      expect(await violated(codeRow, [code, factor.state.id, 0, Buffer.alloc(32)])).toBe(
        'recovery_codes_position_check',
      );
      expect(await violated(codeRow, [code, factor.state.id, 3, Buffer.alloc(32)])).toBe(
        'recovery_codes_pkey',
      );
    });

    it('refuses a broken challenge', async () => {
      const account = await insertAdmin();
      const challengeRow = `INSERT INTO identity.sign_in_challenges (id, market_id, tenant_id,
        account_id, purpose, token_hash, attempts, credential_changed_at, expires_at, created_at)
        VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, $8, $7)`;
      const row = (purpose: string, hash: Buffer, attempts: number, expires: string) => [
        randomUUID(),
        code,
        account,
        purpose,
        hash,
        attempts,
        CREATED,
        expires,
      ];
      const later = '2026-10-08T00:05:00Z';
      expect(await violated(challengeRow, row('sign-in', Buffer.alloc(32), 0, later))).toBe(
        'sign_in_challenges_purpose_check',
      );
      expect(await violated(challengeRow, row('second-factor', Buffer.alloc(31), 0, later))).toBe(
        'sign_in_challenges_token_hash_check',
      );
      expect(await violated(challengeRow, row('second-factor', randomBytes(32), -1, later))).toBe(
        'sign_in_challenges_attempts_check',
      );
      expect(await violated(challengeRow, row('second-factor', randomBytes(32), 0, CREATED))).toBe(
        'sign_in_challenges_expires_at_check',
      );
    });

    it('refuses a broken invitation, and keeps one pending invitation per address and scope', async () => {
      const invitationRow = `INSERT INTO identity.invitations (id, market_id, tenant_id, kind,
        email, email_normalized, display_name, role_id, seller_id, token_hash, expires_at, state,
        decided_at, accepted_account_id, version, created_at)
        VALUES ($1, $2, 'default', $3, $4, $5, $6, $7, NULL, $8, $9, $10, $11, $12, 1, $13)`;
      const address = `invitee.${randomUUID()}@example.test`;
      const row = (overrides: Partial<Record<string, unknown>> = {}) => [
        randomUUID(),
        code,
        overrides.kind ?? 'admin',
        'email' in overrides ? overrides.email : address,
        'email' in overrides ? overrides.email : address,
        overrides.name ?? null,
        randomUUID(),
        overrides.hash ?? null,
        overrides.expires ?? null,
        overrides.state ?? 'pending',
        overrides.decided ?? null,
        overrides.accepted ?? null,
        CREATED,
      ];
      expect(await violated(invitationRow, row({ email: null }))).toBe(
        'invitations_email_pending_check',
      );
      expect(await violated(invitationRow, row({ name: 'Someone' }))).toBe(
        'invitations_display_name_kind_check',
      );
      expect(await violated(invitationRow, row({ kind: 'staff' }))).toBe(
        'invitations_seller_id_check',
      );
      expect(await violated(invitationRow, row({ hash: Buffer.alloc(32) }))).toBe(
        'invitations_token_check',
      );
      expect(await violated(invitationRow, row({ decided: CREATED }))).toBe(
        'invitations_decided_check',
      );
      expect(
        await violated(
          invitationRow,
          row({ state: 'accepted', decided: CREATED, accepted: randomUUID() }),
        ),
      ).toBe('invitations_email_pending_check');
      expect(
        await violated(
          invitationRow,
          row({ state: 'accepted', decided: CREATED, email: null, accepted: null }),
        ),
      ).toBe('invitations_accepted_check');
      expect(await violated(invitationRow, row())).toBeNull();
      expect(await violated(invitationRow, row())).toBe(
        'invitations_market_id_email_pending_platform_key',
      );
      // The other Market keeps its own invitations.
      await expect(
        sql.query(invitationRow, [randomUUID(), otherMarketOf(code), ...row().slice(2)]),
      ).resolves.toBeDefined();
    });
  });

  describe('the second factor (identity design 3.6, 7)', () => {
    it('stores the sealed secret and the keyed codes, and reads them back as they were', async () => {
      const account = await insertAdmin();
      const { secret, codes, factor } = await enrol(account);

      const read = await unit(() => factors.findByAccount(market, account));

      expect(read?.state).toEqual(factor.state);
      expect(read?.persistedVersion).toBe(1);
      // The secret never appears in clear in the row, and only the sealed form checks a code.
      const { rows } = await sql.query<{ secret_ciphertext: string }>(
        'SELECT secret_ciphertext FROM identity.second_factors WHERE id = $1',
        [factor.state.id],
      );
      expect(rows[0]!.secret_ciphertext).not.toContain(Buffer.from(secret).toString('base64url'));
      const step = timeStepAt(NOW);
      await expect(
        unit(() =>
          secrets.matchStored(
            market,
            account,
            read!.state.secretCiphertext,
            hotp(secret, step),
            candidateSteps(NOW),
          ),
        ),
      ).resolves.toBe(step);
      // A sealed secret is bound to its Market: the other Market cannot even read the row.
      await expect(unit(() => factors.findByAccount(other, account), other)).resolves.toBeNull();
      expect(codes).toHaveLength(10);
    });

    it('accepts a time step exactly once under concurrency, and never an older one (7.1)', async () => {
      const account = await insertAdmin();
      const { factor } = await enrol(account, 100);
      const id = factor.state.id;

      const answers = await Promise.all(
        Array.from({ length: 10 }, () => unit(() => factors.acceptStep(market, id, 101))),
      );

      expect(answers.filter(Boolean)).toHaveLength(1);
      await expect(unit(() => factors.acceptStep(market, id, 100))).resolves.toBe(false);
      await expect(unit(() => factors.acceptStep(market, id, 101))).resolves.toBe(false);
      const read = await unit(() => factors.findByAccount(market, account));
      expect(read?.state).toMatchObject({ lastAcceptedStep: 101, version: 2 });
      // A save of the factor loaded before the step fails as stale, never writes the step back.
      const stale = SecondFactor.restore({ ...read!.state, version: 1 });
      stale.recordLock(NOW);
      await expect(unit(() => factors.save(market, stale))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
    });

    it('spends a recovery code exactly once under concurrency; a wrong code writes nothing (7.3)', async () => {
      const account = await insertAdmin();
      const { codes, factor } = await enrol(account);
      const id = factor.state.id;
      const hash = await unit(() => secrets.recoveryCodeHash(market, account, codes[3]!));

      const answers = await Promise.all(
        Array.from({ length: 10 }, () =>
          unit(() => factors.useRecoveryCode(market, id, hash, NOW)),
        ),
      );

      expect(answers.filter(Boolean)).toHaveLength(1);
      const read = await unit(() => factors.findByAccount(market, account));
      expect(read?.unusedRecoveryCodes.map((c) => c.position)).not.toContain(4);
      expect(read?.unusedRecoveryCodes).toHaveLength(9);
      const version = read!.state.version;
      await expect(unit(() => factors.useRecoveryCode(market, id, HASH(), NOW))).resolves.toBe(
        false,
      );
      const after = await unit(() => factors.findByAccount(market, account));
      expect(after?.state.version).toBe(version);
      // Another account's code does not work here (a hash under another key).
      const stranger = await insertAdmin();
      const theirs = await unit(() => secrets.recoveryCodeHash(market, stranger, codes[5]!));
      await expect(unit(() => factors.useRecoveryCode(market, id, theirs, NOW))).resolves.toBe(
        false,
      );
    });

    it('regenerates the ten codes through a versioned save', async () => {
      const account = await insertAdmin();
      const { factor } = await enrol(account);
      const loaded = (await unit(() => factors.findByAccount(market, account)))!;
      const fresh = Array.from({ length: 10 }, () => HASH());
      expect(loaded.regenerateRecoveryCodes(fresh).ok).toBe(true);

      await unit(() => factors.save(market, loaded));

      const read = await unit(() => factors.findByAccount(market, account));
      expect(read?.state.recoveryCodes.map((c) => Buffer.from(c.codeHash))).toEqual(
        fresh.map((h) => Buffer.from(h)),
      );
      expect(read?.state.version).toBe(factor.state.version + 1);
    });

    it('a factor loaded before a recovery-code use cannot be saved afterwards (Hassan L-2 a)', async () => {
      const account = await insertAdmin();
      const { codes, factor } = await enrol(account);
      const before = (await unit(() => factors.findByAccount(market, account)))!;
      const hash = await unit(() => secrets.recoveryCodeHash(market, account, codes[0]!));
      await expect(
        unit(() => factors.useRecoveryCode(market, factor.state.id, hash, NOW)),
      ).resolves.toBe(true);

      // Saving the older copy would bring the spent code back as unused: refused as stale.
      expect(before.regenerateRecoveryCodes(Array.from({ length: 10 }, () => HASH())).ok).toBe(
        true,
      );
      await expect(unit(() => factors.save(market, before))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      const read = await unit(() => factors.findByAccount(market, account));
      expect(read?.state.recoveryCodes.find((c) => c.position === 1)?.usedAt).not.toBeNull();
    });

    it('a code from before a regeneration no longer works (Hassan L-2 b)', async () => {
      const account = await insertAdmin();
      const { codes, factor } = await enrol(account);
      const oldHash = await unit(() => secrets.recoveryCodeHash(market, account, codes[2]!));
      const loaded = (await unit(() => factors.findByAccount(market, account)))!;
      const fresh = secrets.newRecoveryCodes();
      const freshHashes = await unit(async () => {
        const out: Uint8Array[] = [];
        for (const c of fresh) out.push(await secrets.recoveryCodeHash(market, account, c));
        return out;
      });
      expect(loaded.regenerateRecoveryCodes(freshHashes).ok).toBe(true);
      await unit(() => factors.save(market, loaded));

      await expect(
        unit(() => factors.useRecoveryCode(market, factor.state.id, oldHash, NOW)),
      ).resolves.toBe(false);
      await expect(
        unit(() => factors.useRecoveryCode(market, factor.state.id, freshHashes[2]!, NOW)),
      ).resolves.toBe(true);
    });

    it('never matches a secret sealed for another account or label: an integrity error (Hassan L-1)', async () => {
      const mine = await insertAdmin();
      const theirs = await insertAdmin();
      const secret = secrets.newSecret();
      const step = timeStepAt(NOW);
      const code = hotp(secret, step);
      const sealedForTheirs = await unit(() => secrets.seal(market, theirs, secret));
      const otherLabel = await unit(async () => {
        const sealed = await subjectKeys.encrypt(
          market,
          mine,
          fieldLabel('identity.second-factor.other'),
          Buffer.from(secret).toString('base64url'),
        );
        if (!sealed.ok) throw new Error('key destroyed');
        return sealed.value;
      });

      for (const ciphertext of [sealedForTheirs, otherLabel]) {
        await expect(
          unit(() => secrets.matchStored(market, mine, ciphertext, code, candidateSteps(NOW))),
        ).rejects.toBeInstanceOf(SubjectKeyIntegrityError);
      }
      // Sealed for the right account and label, the same code matches.
      const sealedForMine = await unit(() => secrets.seal(market, mine, secret));
      await expect(
        unit(() => secrets.matchStored(market, mine, sealedForMine, code, candidateSteps(NOW))),
      ).resolves.toBe(step);
    });

    it('refuses a second factor for the account as stale, and removes it at a reset', async () => {
      const account = await insertAdmin();
      await enrol(account);
      await expect(enrol(account)).rejects.toBeInstanceOf(StaleAggregateError);

      await expect(unit(() => factors.removeOf(market, account))).resolves.toBe(true);

      await expect(unit(() => factors.findByAccount(market, account))).resolves.toBeNull();
      const { rows } = await sql.query(
        'SELECT 1 FROM identity.recovery_codes rc JOIN identity.second_factors sf ON sf.id = rc.second_factor_id WHERE sf.account_id = $1',
        [account],
      );
      expect(rows).toEqual([]);
    });

    it('answers which accounts have an active factor, in this Market only', async () => {
      const withFactor = await insertAdmin();
      const pending = await insertAdmin();
      const none = await insertAdmin();
      await enrol(withFactor);
      await unit(async () =>
        factors.add(
          market,
          SecondFactor.startEnrolment({
            id: randomUUID() as Id<'SecondFactor'>,
            marketId: market.marketId,
            accountId: pending,
            secretCiphertext: await secrets.seal(market, pending, secrets.newSecret()),
            now: NOW,
          }),
        ),
      );

      const active = await unit(() => factors.activeAmong(market, [withFactor, pending, none]));

      expect([...active]).toEqual([withFactor]);
      await expect(
        unit(() => factors.activeAmong(other, [withFactor, pending, none]), other),
      ).resolves.toEqual(new Set());
    });
  });

  describe('the sign-in challenge (identity design 6.3, 6.8; HF1, HF11)', () => {
    const policy = { maxAttempts: 5, lifetimeSeconds: 300 };
    const open = async (account: Id<'Account'>) => {
      const challenge = issueChallenge({
        id: randomUUID() as Id<'SignInChallenge'>,
        marketId: market.marketId,
        accountId: account,
        purpose: 'second-factor',
        credentialChangedAt: NOW.subtract({ hours: 1 }),
        policy,
        now: NOW,
      });
      const hash = HASH();
      await unit(() => challenges.add(market, challenge, hash));
      return { challenge, hash };
    };

    it('allows exactly five checks to twenty concurrent attempts', async () => {
      const { challenge } = await open(await insertAdmin());

      const answers = await Promise.all(
        Array.from({ length: 20 }, () =>
          unit(() => challenges.reserveAttempt(market, challenge.id, policy.maxAttempts, NOW)),
        ),
      );

      expect(answers.filter(Boolean)).toHaveLength(policy.maxAttempts);
    });

    it('is found by its hash in its Market only, consumed once, and refused after its expiry', async () => {
      const { challenge, hash } = await open(await insertAdmin());
      await expect(unit(() => challenges.findByTokenHash(market, hash))).resolves.toEqual(
        challenge,
      );
      await expect(unit(() => challenges.findByTokenHash(other, hash), other)).resolves.toBeNull();
      const expiry = challenge.expiresAt;
      await expect(
        unit(() => challenges.reserveAttempt(market, challenge.id, 5, expiry)),
      ).resolves.toBe(false);
      await expect(unit(() => challenges.consume(market, challenge.id, expiry))).resolves.toBe(
        false,
      );
      const answers = await Promise.all(
        Array.from({ length: 5 }, () => unit(() => challenges.consume(market, challenge.id, NOW))),
      );
      expect(answers.filter(Boolean)).toHaveLength(1);
      await expect(
        unit(() => challenges.reserveAttempt(market, challenge.id, 5, NOW)),
      ).resolves.toBe(false);
    });

    it('voids every challenge of the account and no other (HF11)', async () => {
      const account = await insertAdmin();
      const stranger = await insertAdmin();
      await open(account);
      await open(account);
      const theirs = await open(stranger);

      await expect(unit(() => challenges.voidAllOf(market, account))).resolves.toBe(2);

      await expect(
        unit(() => challenges.findByTokenHash(market, theirs.hash)),
      ).resolves.not.toBeNull();
    });

    it('purges expired challenges only', async () => {
      const account = await insertAdmin();
      const { challenge, hash } = await open(account);
      await unit(() => challenges.purgeExpired(market, NOW));
      await expect(unit(() => challenges.findByTokenHash(market, hash))).resolves.not.toBeNull();
      await unit(() => challenges.purgeExpired(market, challenge.expiresAt.add({ seconds: 1 })));
      await expect(unit(() => challenges.findByTokenHash(market, hash))).resolves.toBeNull();
    });
  });

  describe('the invitation (identity design 3.4; M12)', () => {
    const adminInvitation = (address: string, at: Temporal.Instant = NOW) =>
      Invitation.issue({
        id: randomUUID() as Id<'Invitation'>,
        marketId: market.marketId,
        kind: 'admin',
        email: emailOf(address),
        roleId: randomUUID() as Id<'Role'>,
        sellerId: null,
        invitedByAccountId: null,
        now: at,
      });
    const sellerInvitation = (
      kind: 'seller-owner' | 'staff',
      sellerId: Id<'Seller'>,
      address: string,
    ) =>
      Invitation.issue({
        id: randomUUID() as Id<'Invitation'>,
        marketId: market.marketId,
        kind,
        email: emailOf(address),
        displayName: kind === 'seller-owner' ? 'Shop Owner' : null,
        roleId: randomUUID() as Id<'Role'>,
        sellerId,
        invitedByAccountId: null,
        now: NOW,
      });
    /** A seller access row the seller-scoped invitations point at (RESTRICT FK). */
    async function insertSeller(): Promise<Id<'Seller'>> {
      const sellerId = randomUUID() as Id<'Seller'>;
      await sql.query(
        `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
           state_changed_at, reapply_count, registered_at, version, created_at)
         VALUES ($1, $2, 'default', 'self', 'approved', $3, 0, $3, 1, $3)`,
        [sellerId, code, CREATED],
      );
      return sellerId;
    }
    /** Loads, changes and saves one invitation in its own unit. */
    async function decide(id: Id<'Invitation'>, how: 'revoke' | 'accept', at: Temporal.Instant) {
      const loaded = (await unit(() => invitations.findById(market, id)))!;
      const done =
        how === 'revoke' ? loaded.revoke(at) : loaded.accept(randomUUID() as Id<'Account'>, at);
      expect(done.ok).toBe(true);
      await unit(() => invitations.save(market, loaded));
    }
    const exists = async (id: Id<'Invitation'>) =>
      (await unit(() => invitations.findById(market, id))) !== null;

    it('is stored, dispatched, found by its hash and accepted through versioned saves', async () => {
      const address = `First.Admin.${randomUUID()}@Example.test`;
      const issued = adminInvitation(address);
      await unit(() => invitations.add(market, issued));
      const loaded = (await unit(() => invitations.findById(market, issued.state.id)))!;
      expect(loaded.state).toEqual(issued.state);
      const hash = HASH();
      loaded.dispatch(hash, NOW, 4320);
      await unit(() => invitations.save(market, loaded));

      const found = (await unit(() => invitations.findByTokenHash(market, hash)))!;
      expect(found.usableAt(NOW)).toBe(true);
      await expect(unit(() => invitations.findByTokenHash(other, hash), other)).resolves.toBeNull();
      const account = await insertAdmin();
      expect(found.accept(account, NOW.add({ minutes: 1 })).ok).toBe(true);
      await unit(() => invitations.save(market, found));
      // A second save of the copy loaded before the acceptance is stale.
      const stale = Invitation.restore(loaded.state);
      stale.revoke(NOW);
      await expect(unit(() => invitations.save(market, stale))).rejects.toBeInstanceOf(
        StaleAggregateError,
      );
      // The address left with the decision (data design 4).
      const { rows } = await sql.query<{ email: string | null }>(
        'SELECT email, email_normalized FROM identity.invitations WHERE id = $1',
        [issued.state.id],
      );
      expect(rows[0]).toEqual({ email: null, email_normalized: null });
    });

    it('answers already-pending for a second pending invitation to the address, and not after a revocation', async () => {
      const address = `Twice.${randomUUID()}@example.test`;
      const first = adminInvitation(address);
      await unit(() => invitations.add(market, first));
      await expect(
        unit(() => invitations.add(market, adminInvitation(address))),
      ).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
      const loaded = (await unit(() => invitations.findById(market, first.state.id)))!;
      loaded.revoke(NOW);
      await unit(() => invitations.save(market, loaded));
      await expect(unit(() => invitations.add(market, adminInvitation(address)))).resolves.toBe(
        undefined,
      );
    });

    it('keeps one pending invitation per seller and address, released by a revocation or an acceptance (M12; Sajad 1)', async () => {
      const sellerId = await insertSeller();
      const otherSeller = await insertSeller();
      const address = `Staff.${randomUUID()}@example.test`;
      const first = sellerInvitation('staff', sellerId, address);
      await unit(() => invitations.add(market, first));

      // The same address for the same seller: invitations_market_id_seller_id_email_pending_key.
      await expect(
        unit(() => invitations.add(market, sellerInvitation('staff', sellerId, address))),
      ).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
      // Another seller, or the platform scope, may invite the same address.
      await unit(() => invitations.add(market, sellerInvitation('staff', otherSeller, address)));
      await unit(() => invitations.add(market, adminInvitation(address)));

      await decide(first.state.id, 'revoke', NOW);
      const second = sellerInvitation('staff', sellerId, address);
      await unit(() => invitations.add(market, second));
      const hash = HASH();
      const loaded = (await unit(() => invitations.findById(market, second.state.id)))!;
      loaded.dispatch(hash, NOW, 60);
      await unit(() => invitations.save(market, loaded));
      await decide(second.state.id, 'accept', NOW.add({ minutes: 1 }));
      await expect(
        unit(() => invitations.add(market, sellerInvitation('staff', sellerId, address))),
      ).resolves.toBeUndefined();
    });

    it('keeps one pending seller-owner invitation per seller, released by a revocation or an acceptance (HF5 (a), M12; Sajad 1)', async () => {
      const sellerId = await insertSeller();
      const owner = sellerInvitation(
        'seller-owner',
        sellerId,
        `Owner.${randomUUID()}@example.test`,
      );
      await unit(() => invitations.add(market, owner));

      // Another address, same seller: invitations_market_id_seller_id_owner_pending_key.
      await expect(
        unit(() =>
          invitations.add(
            market,
            sellerInvitation('seller-owner', sellerId, `Other.${randomUUID()}@example.test`),
          ),
        ),
      ).rejects.toBeInstanceOf(InvitationAlreadyPendingError);
      // A staff invitation for the seller is not an owner invitation.
      await unit(() =>
        invitations.add(
          market,
          sellerInvitation('staff', sellerId, `Staff.${randomUUID()}@example.test`),
        ),
      );

      await decide(owner.state.id, 'revoke', NOW);
      const next = sellerInvitation('seller-owner', sellerId, `Next.${randomUUID()}@example.test`);
      await unit(() => invitations.add(market, next));
      const loaded = (await unit(() => invitations.findById(market, next.state.id)))!;
      loaded.dispatch(HASH(), NOW, 60);
      await unit(() => invitations.save(market, loaded));
      await decide(next.state.id, 'accept', NOW.add({ minutes: 1 }));
      await expect(
        unit(() =>
          invitations.add(
            market,
            sellerInvitation('seller-owner', sellerId, `Third.${randomUUID()}@example.test`),
          ),
        ),
      ).resolves.toBeUndefined();
    });

    it('purges decided invitations older than the cut-off only, never a pending one by that clause (Sajad 2)', async () => {
      const cutoff = NOW.subtract({ hours: 30 * 24 });
      const made: Record<string, Id<'Invitation'>> = {};
      for (const [name, how, decidedAt] of [
        ['acceptedOld', 'accept', cutoff.subtract({ hours: 24 })],
        ['revokedOld', 'revoke', cutoff.subtract({ hours: 24 })],
        ['acceptedNew', 'accept', cutoff.add({ hours: 24 })],
        ['revokedNew', 'revoke', cutoff.add({ hours: 24 })],
      ] as const) {
        const issued = adminInvitation(`${name}.${randomUUID()}@example.test`, decidedAt);
        issued.dispatch(HASH(), decidedAt, 60);
        await unit(() => invitations.add(market, issued));
        await decide(issued.state.id, how, decidedAt.add({ minutes: 1 }));
        made[name] = issued.state.id;
      }
      // Pending and created long before the cut-off, but dispatched and unexpired.
      const pendingOld = adminInvitation(
        `Pending.${randomUUID()}@example.test`,
        cutoff.subtract({ hours: 48 }),
      );
      pendingOld.dispatch(HASH(), cutoff.subtract({ hours: 48 }), 60 * 24 * 365);
      await unit(() => invitations.add(market, pendingOld));

      await unit(() => invitations.purge(market, NOW, cutoff));

      expect(await exists(made.acceptedOld!)).toBe(false);
      expect(await exists(made.revokedOld!)).toBe(false);
      expect(await exists(made.acceptedNew!)).toBe(true);
      expect(await exists(made.revokedNew!)).toBe(true);
      expect(await exists(pendingOld.state.id)).toBe(true);
    });

    it("purges a never-dispatched pending invitation older than its kind's cut-off only (Ali 2026-10-08)", async () => {
      const sellerId = await insertSeller();
      const adminOld = adminInvitation(
        `AdminOld.${randomUUID()}@example.test`,
        NOW.subtract({ hours: 73 }),
      );
      const adminNew = adminInvitation(
        `AdminNew.${randomUUID()}@example.test`,
        NOW.subtract({ hours: 71 }),
      );
      const staffOld = sellerInvitation('staff', sellerId, `StaffOld.${randomUUID()}@example.test`);
      const dispatchedOld = adminInvitation(
        `Sent.${randomUUID()}@example.test`,
        NOW.subtract({ hours: 100 }),
      );
      dispatchedOld.dispatch(HASH(), NOW.subtract({ hours: 100 }), 60 * 24 * 30);
      for (const invitation of [adminOld, adminNew, staffOld, dispatchedOld]) {
        await unit(() => invitations.add(market, invitation));
      }

      // A cut-off for admin only (now - 72 h): staff has none, so it is left alone.
      await unit(() =>
        invitations.purge(market, NOW, NOW.subtract({ hours: 30 * 24 }), {
          admin: NOW.subtract({ hours: 72 }),
        }),
      );

      expect(await exists(adminOld.state.id)).toBe(false);
      expect(await exists(adminNew.state.id)).toBe(true);
      expect(await exists(staffOld.state.id)).toBe(true);
      // Dispatched: its expiry decides, not its age.
      expect(await exists(dispatchedOld.state.id)).toBe(true);
    });

    it('purges pending invitations past their expiry and decisions older than the cut-off', async () => {
      const expired = adminInvitation(`Expired.${randomUUID()}@example.test`);
      expired.dispatch(HASH(), NOW, 60);
      const live = adminInvitation(`Live.${randomUUID()}@example.test`);
      live.dispatch(HASH(), NOW, 4320);
      await unit(() => invitations.add(market, expired));
      await unit(() => invitations.add(market, live));

      await unit(() =>
        invitations.purge(market, NOW.add({ hours: 2 }), NOW.subtract({ hours: 30 * 24 })),
      );

      await expect(unit(() => invitations.findById(market, expired.state.id))).resolves.toBeNull();
      await expect(unit(() => invitations.findById(market, live.state.id))).resolves.not.toBeNull();
    });
  });

  it('removes the factor, its codes and the challenges with the account (data design C8)', async () => {
    const account = await insertAdmin();
    await enrol(account);
    const challenge = issueChallenge({
      id: randomUUID() as Id<'SignInChallenge'>,
      marketId: market.marketId,
      accountId: account,
      purpose: 'second-factor',
      credentialChangedAt: NOW,
      policy: { maxAttempts: 5, lifetimeSeconds: 300 },
      now: NOW,
    });
    await unit(() => challenges.add(market, challenge, HASH()));

    await sql.query('DELETE FROM identity.accounts WHERE id = $1', [account]);

    for (const table of ['second_factors', 'sign_in_challenges']) {
      const { rows } = await sql.query(`SELECT 1 FROM identity.${table} WHERE account_id = $1`, [
        account,
      ]);
      expect([table, rows]).toEqual([table, []]);
    }
  });

  // Identity design 8.7 and 12.1 row 7 (Hassan M2, L-B): the reviewer rule with real factors.
  // Real roles, grants and factors in the database, the real registry, and the production
  // resolver, factor read and gate.
  it('equivalence with real factors: an admin with an active factor is a recipient exactly when the gate allows permissions [approve]', async () => {
    const roleId = async (kind: 'system' | 'custom', keys: string[]) => {
      if (kind === 'system') {
        await sql.query(
          `INSERT INTO identity.roles (id, market_id, tenant_id, scope, kind, seed_code,
           seed_version, version, created_at)
           VALUES ($1, $2, 'default', 'platform', 'system', 'platform-administrator', 1, 1, $3)
           ON CONFLICT DO NOTHING`,
          [randomUUID(), code, CREATED],
        );
        const { rows } = await sql.query<{ id: string }>(
          `SELECT id FROM identity.roles WHERE market_id = $1 AND scope = 'platform' AND kind = 'system'`,
          [code],
        );
        return rows[0]!.id;
      }
      const id = randomUUID();
      const name = `approvers ${id}`;
      await sql.query(
        `INSERT INTO identity.roles (id, market_id, tenant_id, scope, kind, name,
         name_normalized, version, created_at)
         VALUES ($1, $2, 'default', 'platform', 'custom', $3, $3, 1, $4)`,
        [id, code, name, CREATED],
      );
      for (const key of keys) {
        await sql.query(
          `INSERT INTO identity.role_permissions (market_id, tenant_id, role_id, permission_key)
           VALUES ($1, 'default', $2, $3)`,
          [code, id, key],
        );
      }
      return id;
    };
    const assign = (account: string, role: string) =>
      sql.query(
        `INSERT INTO identity.role_assignments (id, market_id, tenant_id, account_id, role_id,
         assigned_at, version) VALUES ($1, $2, 'default', $3, $4, $5, 1)`,
        [randomUUID(), code, account, role, CREATED],
      );

    const system = await roleId('system', []);
    const approver = await roleId('custom', [SELLER_ACCESS_APPROVE, 'identity.seller-access.view']);
    const viewer = await roleId('custom', ['identity.seller-access.view']);
    const administrator = await insertAdmin(); // system role, active factor: a recipient
    const customApprover = await insertAdmin(); // custom approve role, active factor: a recipient
    const noFactor = await insertAdmin(); // system role, no factor
    const pendingFactor = await insertAdmin(); // approve role, pending factor only
    const withoutKey = await insertAdmin(); // viewer role, active factor
    const noRole = await insertAdmin(); // no role, active factor
    await assign(administrator, system);
    await assign(customApprover, approver);
    await assign(noFactor, system);
    await assign(pendingFactor, approver);
    await assign(withoutKey, viewer);
    for (const account of [administrator, customApprover, withoutKey, noRole]) {
      await enrol(account);
    }
    await unit(async () =>
      factors.add(
        market,
        SecondFactor.startEnrolment({
          id: randomUUID() as Id<'SecondFactor'>,
          marketId: market.marketId,
          accountId: pendingFactor,
          secretCiphertext: await secrets.seal(market, pendingFactor, secrets.newSecret()),
          now: NOW,
        }),
      ),
    );
    const mine = [administrator, customApprover, noFactor, pendingFactor, withoutKey, noRole];

    const effectiveKeys = realEffectiveKeys();
    const grants = new PrismaRoleGrantReader(db.service);
    const reviewers = new AccountAccessReviewers({
      unitOfWork: db.unitOfWork,
      candidates: new PrismaReviewerCandidateReader(db.service),
      grants,
      effectiveKeys,
      factors,
    });
    const recipients = new Set(
      (await reviewers.reviewersOf(market))
        .map((r) => r.accountId as string)
        .filter((a) => mine.includes(a as Id<'Account'>)),
    );
    expect([...recipients].sort()).toEqual([administrator, customApprover].sort());

    const accounts = new PrismaAccountRepository(db.service, subjectKeys);
    const check = new AccountAuthorisationCheck({
      unitOfWork: db.unitOfWork,
      accounts,
      memberships: new PrismaSellerMembershipRepository(db.service),
      sellerAccess: new PrismaSellerAccessRepository(db.service, subjectKeys),
      grants,
      effectiveKeys,
    });
    const approve: AccessDeclaration = {
      name: 'identity.approve-anything',
      rule: { kind: 'permissions', allOf: [SELLER_ACCESS_APPROVE as never] },
    };
    const withActiveFactor = await unit(() => factors.activeAmong(market, mine));
    const compared: [string, boolean][] = [];
    for (const account of mine.filter((a) => withActiveFactor.has(a))) {
      const context = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'admin',
          accountId: account,
          sessionId: randomUUID() as Id<'Session'>,
          sellerId: null,
        }),
      );
      const allowed = (await check.check(context, approve)).allowed;
      expect([account, recipients.has(account)]).toEqual([account, allowed]);
      compared.push([account, allowed]);
    }
    // Non-vacuous: both answers occur among the accounts with an active factor.
    expect(compared.some(([, allowed]) => allowed)).toBe(true);
    expect(compared.some(([, allowed]) => !allowed)).toBe(true);
    // Separately: an account the gate would allow but without an active factor is never one.
    expect(recipients.has(noFactor)).toBe(false);
    expect(recipients.has(pendingFactor)).toBe(false);
  });
});
