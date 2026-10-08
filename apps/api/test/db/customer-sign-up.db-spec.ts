import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Temporal } from '@mondapac/shared-kernel';
import type { MarketId } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { RegisterCustomer } from '../../src/modules/identity/application/use-cases/register-customer.use-case';
import { Account, type AccountState } from '../../src/modules/identity/domain/account';
import { IDENTITY_EVENTS } from '../../src/modules/identity/domain/events';
import { MarketConfigIdentityPolicy } from '../../src/modules/identity/infrastructure/market-config-identity-policy';
import { Argon2idPasswordHasher } from '../../src/modules/identity/infrastructure/passwords/argon2id-password-hasher';
import { CheckedInCommonPasswords } from '../../src/modules/identity/infrastructure/passwords/checked-in-common-passwords';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import {
  HmacThrottleKeys,
  localThrottleSecret,
} from '../../src/modules/identity/infrastructure/sessions/hmac-throttle-keys';
import { PrismaThrottleRepository } from '../../src/modules/identity/infrastructure/sessions/prisma-throttle.repository';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// Customer sign-up end to end on PostgreSQL (identity design 3.2, 6.7, HF12; data design 3.3,
// N1; slice 1d), as the application role, for both Market fixtures: the real repository,
// unit of work, outbox writer, SubjectKeyService and argon2id hasher; only the clock is fixed.

const PASSWORD = 'correct horse battery staple';
/** The client origin of every sign-up here (the mail.origin counter, L4). */
const ORIGIN = '192.0.2.10';
const NOTICE_HOURS: Record<string, number> = { AU: 24, ZZ: 12 };

interface AccountRow {
  id: string;
  market_id: string;
  tenant_id: string;
  population: string;
  email: string;
  email_normalized: string;
  display_name: string | null;
  status: string;
  email_verified_at: Date | null;
  existing_account_notice_at: Date | null;
  signed_up_at: Date;
  version: number;
}

describe('customer sign-up (database integration)', () => {
  const clock = new FixedClock(Temporal.Instant.from('2026-10-07T00:00:00Z'));
  // Real UUIDv7 ids: other suites share the database and a fixed clock would repeat theirs.
  let db: Persistence;
  let sql: Client;
  let repository: PrismaAccountRepository;
  let keys: HmacThrottleKeys;
  let useCase: RegisterCustomer;
  let warnings: jest.SpyInstance;

  beforeAll(async () => {
    db = createPersistence();
    const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
    const catalogue = new EventCatalogue();
    catalogue.register('identity', IDENTITY_EVENTS);
    catalogue.seal();
    const subjectKeys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(db.service, db.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    repository = new PrismaAccountRepository(db.service, subjectKeys);
    keys = new HmacThrottleKeys(localThrottleSecret({ nodeEnv: 'test', nodeEnvExplicit: true }));
    useCase = new RegisterCustomer(createUseCaseGate(markets, null), {
      unitOfWork: db.unitOfWork,
      accounts: repository,
      throttles: new PrismaThrottleRepository(db.service),
      keys,
      outbox: new PrismaOutboxWriterFactory(
        modelMap,
        db.service,
        catalogue,
        ids,
        NO_PERMISSION_KEYS,
      ).forModule('identity'),
      hasher: new Argon2idPasswordHasher(),
      commonPasswords: new CheckedInCommonPasswords(),
      policy: new MarketConfigIdentityPolicy(markets),
      clock,
      ids,
    });
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });

  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  beforeEach(() => {
    warnings = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warnings.mockRestore());

  const accountsOf = async (code: string, emailNormalized: string): Promise<AccountRow[]> =>
    (
      await sql.query<AccountRow>(
        `SELECT * FROM identity.accounts
          WHERE market_id = $1 AND population = 'customer' AND email_normalized = $2`,
        [code, emailNormalized],
      )
    ).rows;
  const credentialOf = async (accountId: string) =>
    (
      await sql.query<{ password_hash: string; changed_at: Date; market_id: string }>(
        'SELECT * FROM identity.password_credentials WHERE account_id = $1',
        [accountId],
      )
    ).rows;
  const eventsOf = async (accountId: string) =>
    (
      await sql.query<{
        type: string;
        market_id: string;
        aggregate_version: number;
        payload: unknown;
      }>('SELECT * FROM identity.outbox WHERE aggregate_id = $1 ORDER BY aggregate_version', [
        accountId,
      ])
    ).rows;

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);
    const context = () => testCallContext(market, 'anonymous', `db-sign-up-${randomUUID()}`);
    const freshEmail = () => `Sign.Up+${randomUUID()}@Example.com`;

    it('stores the account without a name, its argon2id credential, its key and its event', async () => {
      const email = freshEmail();

      await expect(
        useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }),
      ).resolves.toEqual({
        ok: true,
        value: { code: 'sign-up.accepted' },
      });

      const [account, ...others] = await accountsOf(code, email.toLowerCase());
      expect(others).toEqual([]);
      expect(account).toMatchObject({
        market_id: code,
        tenant_id: market.tenantId,
        email,
        display_name: null,
        status: 'active',
        email_verified_at: null,
        version: 1,
      });
      const [credential] = await credentialOf(account!.id);
      expect(credential?.market_id).toBe(code);
      expect(credential?.password_hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
      expect(credential?.password_hash).not.toContain(PASSWORD);
      const keys = await sql.query(
        'SELECT market_id FROM platform.subject_keys WHERE subject_id = $1',
        [account!.id],
      );
      expect(keys.rows).toEqual([{ market_id: code }]);
      expect(await eventsOf(account!.id)).toMatchObject([
        {
          type: 'identity.customer-account-registered.v1',
          market_id: code,
          aggregate_version: 1,
          payload: { accountId: account!.id },
        },
      ]);
    });

    it('replaces the password of an unverified account and records the repeat', async () => {
      const email = freshEmail();
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD });
      const [before] = await accountsOf(code, email.toLowerCase());
      const [oldCredential] = await credentialOf(before!.id);
      clock.advance(Temporal.Duration.from({ hours: 2 }));

      await useCase.execute(context(), {
        origin: ORIGIN,
        email: email.toUpperCase(),
        password: `${PASSWORD}!`,
      });

      const [after] = await accountsOf(code, email.toLowerCase());
      expect(after).toMatchObject({ id: before!.id, version: 2, email });
      expect(after!.signed_up_at.getTime()).toBe(clock.now().epochMilliseconds);
      const [newCredential] = await credentialOf(before!.id);
      expect(newCredential?.password_hash).not.toBe(oldCredential?.password_hash);
      expect((await eventsOf(before!.id)).map((e) => [e.type, e.payload])).toEqual([
        ['identity.customer-account-registered.v1', { accountId: before!.id }],
        ['identity.sign-up-repeated.v1', { accountId: before!.id, cause: 'unverified-replaced' }],
      ]);
    });

    it("records one notice for a verified account per the Market's interval", async () => {
      const email = freshEmail();
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD });
      const [account] = await accountsOf(code, email.toLowerCase());
      // Verification arrives with slice 3; the owner role sets it here.
      await sql.query(
        'UPDATE identity.accounts SET email_verified_at = signed_up_at WHERE id = $1',
        [account!.id],
      );
      const [credential] = await credentialOf(account!.id);

      await useCase.execute(context(), { origin: ORIGIN, email, password: `${PASSWORD} again` });
      clock.advance(Temporal.Duration.from({ hours: NOTICE_HOURS[code]! - 1 }));
      await useCase.execute(context(), { origin: ORIGIN, email, password: `${PASSWORD} again` });
      clock.advance(Temporal.Duration.from({ hours: 1 }));
      await useCase.execute(context(), { origin: ORIGIN, email, password: `${PASSWORD} again` });

      const causes = (await eventsOf(account!.id)).map(
        (e) => (e.payload as { cause?: string }).cause ?? e.type,
      );
      expect(causes).toEqual([
        'identity.customer-account-registered.v1',
        'verified-notice',
        'verified-notice',
      ]);
      const [after] = await accountsOf(code, email.toLowerCase());
      expect(after?.version).toBe(3);
      expect(after?.existing_account_notice_at?.getTime()).toBe(clock.now().epochMilliseconds);
      // The password of a verified account never changes through sign-up.
      expect((await credentialOf(account!.id))[0]?.password_hash).toBe(credential?.password_hash);
    });

    it('counts the mail of every branch on the mail.account counter (Hassan L4)', async () => {
      const email = freshEmail();
      const normalized = email.toLowerCase();
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }); // new
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }); // replaced
      const [account] = await accountsOf(code, normalized);
      await sql.query(
        'UPDATE identity.accounts SET email_verified_at = signed_up_at WHERE id = $1',
        [account!.id],
      );
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }); // notice
      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }); // unchanged

      const counter = await sql.query<{ attempts: number; account_key: Buffer }>(
        `SELECT attempts, account_key FROM identity.sign_in_throttles
          WHERE market_id = $1 AND kind = 'mail.account' AND key_hash = $2`,
        [code, Buffer.from(keys.account(market, 'customer', normalized))],
      );
      expect(counter.rows).toHaveLength(1);
      expect(counter.rows[0]!.attempts).toBe(4);
      // Only keyed hashes are stored: never the address.
      const raw = await sql.query<{ row: string }>(
        `SELECT t::text AS row FROM identity.sign_in_throttles t WHERE market_id = $1`,
        [code],
      );
      expect(JSON.stringify(raw.rows)).not.toContain(normalized);
    });

    it('treats the NFC, NFD and mixed-case forms of one address as one account (Sajad G2)', async () => {
      // Built from code points so no combining mark is hidden in this file.
      const local = `zo${String.fromCodePoint(0xe9)}-${randomUUID()}`; // composed e-acute
      const decomposed = local.replace(
        String.fromCodePoint(0xe9),
        `e${String.fromCodePoint(0x301)}`,
      );
      const nfc = `${local}@example.com`;
      const nfd = `${decomposed}@example.com`;
      const mixed = `${decomposed.toUpperCase()}@EXAMPLE.com`;
      expect(nfd).not.toBe(nfc);

      for (const email of [nfc, nfd, mixed]) {
        await expect(
          useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD }),
        ).resolves.toEqual({
          ok: true,
          value: { code: 'sign-up.accepted' },
        });
      }

      const accounts = await accountsOf(code, nfc.normalize('NFC').toLowerCase());
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ email: nfc, version: 3 });
      expect((await eventsOf(accounts[0]!.id)).map((e) => [e.type, e.payload])).toEqual([
        ['identity.customer-account-registered.v1', { accountId: accounts[0]!.id }],
        [
          'identity.sign-up-repeated.v1',
          { accountId: accounts[0]!.id, cause: 'unverified-replaced' },
        ],
        [
          'identity.sign-up-repeated.v1',
          { accountId: accounts[0]!.id, cause: 'unverified-replaced' },
        ],
      ]);
    });

    it('keeps Markets apart: the same address in the other Market is a second account', async () => {
      const email = freshEmail();
      const other = otherMarketOf(code);

      await useCase.execute(context(), { origin: ORIGIN, email, password: PASSWORD });
      await useCase.execute(testCallContext(marketOf(other), 'anonymous'), {
        origin: ORIGIN,
        email,
        password: PASSWORD,
      });

      const [mine] = await accountsOf(code, email.toLowerCase());
      const [theirs] = await accountsOf(other, email.toLowerCase());
      expect(mine?.version).toBe(1);
      expect(theirs?.version).toBe(1);
      expect(mine?.id).not.toBe(theirs?.id);
    });

    it('answers the same to concurrent sign-ups of one new address, and stores one account', async () => {
      const email = freshEmail();

      const answers = await Promise.all(
        [1, 2, 3].map((n) =>
          useCase.execute(context(), { origin: ORIGIN, email, password: `${PASSWORD} ${n}` }),
        ),
      );

      expect(answers).toEqual(
        Array(3).fill({ ok: true, value: { code: 'sign-up.accepted' } }) as unknown[],
      );
      expect(await accountsOf(code, email.toLowerCase())).toHaveLength(1);
    });

    describe('the repository turns a refused CHECK into validation.failed, never a 500 (N1)', () => {
      const now = clock.now();
      const stateFor = (overrides: Partial<AccountState>): AccountState => {
        const email = freshEmail();
        return {
          id: ids.next<'Account'>(),
          marketId: code as MarketId,
          population: 'customer',
          email: { typed: email, normalized: email.toLowerCase() },
          displayName: null,
          status: 'active',
          emailVerifiedAt: null,
          existingAccountNoticeAt: null,
          signedUpAt: now,
          createdAt: now,
          version: 1,
          credential: {
            passwordHash: '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$dGFn',
            changedAt: now,
          },
          ...overrides,
        };
      };
      // The aggregate refuses these states itself; the repository reads `state` only, so a
      // stand-in proves the database's answer is mapped (defence in depth).
      const standIn = (state: AccountState) => ({ state }) as unknown as Account;

      async function add(state: AccountState) {
        return db.unitOfWork.run(market, () => repository.add(market, standIn(state)));
      }

      it('a seller-side account without a name: accounts_display_name_required_check', async () => {
        await expect(add(stateFor({ population: 'seller' }))).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed' },
        });
      });

      it('a name that breaks accounts_display_name_check', async () => {
        await expect(add(stateFor({ displayName: ' padded ' }))).resolves.toEqual({
          ok: false,
          error: { code: 'validation.failed' },
        });
      });

      it('a credential that is not a PHC string', async () => {
        await expect(
          add(stateFor({ credential: { passwordHash: 'plain', changedAt: now } })),
        ).resolves.toEqual({ ok: false, error: { code: 'validation.failed' } });
      });

      it('an address another account of the Market already holds: account.email-taken', async () => {
        const first = stateFor({});
        await add(first);
        const again = stateFor({ email: first.email, id: ids.next<'Account'>() });

        await expect(add(again)).resolves.toEqual({
          ok: false,
          error: { code: 'account.email-taken' },
        });
      });

      it('a valid restored aggregate is stored', async () => {
        await expect(
          db.unitOfWork.run(market, () => repository.add(market, Account.restore(stateFor({})))),
        ).resolves.toEqual({ ok: true, value: undefined });
      });
    });
  });
});
