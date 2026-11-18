import { randomUUID } from 'node:crypto';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { FixedClock } from '@mondapac/shared-kernel/testing';
import { Client, DatabaseError } from 'pg';
import { AccountEmailTakenError } from '../../src/modules/identity/application/ports/account.repository';
import { Account } from '../../src/modules/identity/domain/account';
import {
  parseEmailAddress,
  type EmailAddress,
} from '../../src/modules/identity/domain/email-address';
import { PrismaAccountRepository } from '../../src/modules/identity/infrastructure/prisma-account.repository';
import { PrismaEmailChangeStore } from '../../src/modules/identity/infrastructure/prisma-email-change.store';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The admin email change on PostgreSQL (customers admin email change), as the application role,
// for both Market fixtures: the CHECKs of the pending columns and of the notices table, the new
// link purpose, the swap through the real repository, the unique key deciding a clash (the unit
// rolls back whole), one sealed notice per change opened and deleted by its key only, and the
// purge of lapsed pending addresses at the same boundary as the read. The races and the A to B to
// C notices through the real application are customer-email-change-races.db-spec.ts.

const NOW = Temporal.Instant.from('2026-11-16T10:00:00.123456Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';

function email(raw: string): EmailAddress {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('test setup: bad address');
  return parsed.value;
}

describe('identity customer email change (database)', () => {
  let sql: Client;
  let db: Persistence;
  let accounts: PrismaAccountRepository;
  let store: PrismaEmailChangeStore;
  const clock = new FixedClock(NOW);

  beforeAll(async () => {
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    db = createPersistence();
    const keys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(db.service, db.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    accounts = new PrismaAccountRepository(db.service, keys);
    store = new PrismaEmailChangeStore(db.service, keys);
  });

  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  /** The constraint a statement violated, or null when it succeeded. */
  async function violated(statement: Promise<unknown>): Promise<string | null> {
    try {
      await statement;
      return null;
    } catch (error) {
      if (error instanceof DatabaseError) return error.constraint ?? error.code ?? 'unknown';
      throw error;
    }
  }

  /** A well-formed sealed envelope: version, then base64url, 41 characters or more. */
  const ENVELOPE = `v1.${'A'.repeat(40)}`;

  describe.each(TEST_MARKETS)('in market %s', (code) => {
    const market = marketOf(code);

    /** A verified customer stored through the repository; answers its id. */
    async function storedCustomer(address = `${randomUUID()}@example.com`): Promise<Id<'Account'>> {
      const account = Account.registerCustomer({
        id: ids.next<'Account'>(),
        marketId: market.marketId,
        email: email(address),
        passwordHash: HASH,
        now: NOW.subtract({ hours: 48 }),
      });
      account.verifyEmail(NOW.subtract({ hours: 47 }));
      const added = await db.unitOfWork.run(market, async () => {
        const result = await accounts.add(market, account);
        return result.ok ? ok(undefined) : result;
      });
      expect(added.ok).toBe(true);
      return account.state.id;
    }
    const load = async (accountId: Id<'Account'>) => {
      const read = await db.unitOfWork.run(
        market,
        async () => ok(await accounts.findById(market, accountId)),
        { readOnly: true },
      );
      if (!read.ok || read.value === null) throw new Error('test: account missing');
      return read.value;
    };
    const change = (accountId: Id<'Account'>, raw: string, at = NOW) =>
      db.unitOfWork.run(market, async () => {
        const account = await accounts.findById(market, accountId);
        account!.requestEmailChange({ email: email(raw), now: at });
        await accounts.save(market, account!);
        return ok(undefined);
      });

    describe('constraints', () => {
      const update = (accountId: string, set: string, values: unknown[] = []) =>
        sql.query(`UPDATE identity.accounts SET ${set} WHERE id = $${values.length + 1}`, [
          ...values,
          accountId,
        ]);

      it('sets and clears the three pending columns together', async () => {
        const accountId = await storedCustomer();
        expect(await violated(update(accountId, `pending_email = 'a@b.test'`))).toBe(
          'accounts_pending_email_check',
        );
        expect(
          await violated(
            update(accountId, `pending_email = 'a@b.test', pending_email_normalized = 'a@b.test'`),
          ),
        ).toBe('accounts_pending_email_check');
        expect(
          await violated(
            update(
              accountId,
              `pending_email = 'A@b.test', pending_email_normalized = 'a@b.test',
               pending_email_requested_at = now()`,
            ),
          ),
        ).toBeNull();
      });

      it('keeps the normalised pending address lower-case, trimmed and NFC, 3 to 254 long', async () => {
        const accountId = await storedCustomer();
        const set = `pending_email = $1, pending_email_normalized = $2, pending_email_requested_at = now()`;
        expect(await violated(update(accountId, set, ['A@b.test', 'A@b.test']))).toBe(
          'accounts_pending_email_normalized_check',
        );
        expect(await violated(update(accountId, set, ['a@b.test', ' a@b.test']))).toBe(
          'accounts_pending_email_normalized_check',
        );
        expect(await violated(update(accountId, set, ['zé@b.test', 'zé@b.test']))).toBe(
          'accounts_pending_email_normalized_check',
        );
        expect(await violated(update(accountId, set, ['ab', 'ab']))).toBe(
          'accounts_pending_email_length_check',
        );
      });

      it('allows a pending address on a customer account only', async () => {
        const sellerId = randomUUID();
        await sql.query(
          `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
             email_normalized, display_name, status, signed_up_at, version, created_at)
           VALUES ($1, $2, 'default', 'seller', $3, $3, 'Shop', 'active', now(), 1, now())`,
          [sellerId, code, `${sellerId}@example.com`],
        );
        expect(
          await violated(
            update(
              sellerId,
              `pending_email = 'a@b.test', pending_email_normalized = 'a@b.test',
               pending_email_requested_at = now()`,
            ),
          ),
        ).toBe('accounts_pending_email_customer_check');
      });

      it('takes only sealed envelopes in a notice, a version above 1 and one row per change', async () => {
        const accountId = await storedCustomer();
        const insert = (previous: string, next: string, version = 2) =>
          sql.query(
            `INSERT INTO identity.email_change_notices (market_id, tenant_id, account_id,
               account_version, previous_email, new_email, created_at)
             VALUES ($1, 'default', $2, $3, $4, $5, now())`,
            [code, accountId, version, previous, next],
          );
        for (const plain of [
          'old@example.com',
          'v1.jane@mail.test',
          'v1.short',
          `v0.${'A'.repeat(40)}`,
          `v1.${'A'.repeat(2046)}`,
        ]) {
          expect(await violated(insert(plain, ENVELOPE))).toBe(
            'email_change_notices_previous_email_check',
          );
          expect(await violated(insert(ENVELOPE, plain))).toBe(
            'email_change_notices_new_email_check',
          );
        }
        expect(await violated(insert(ENVELOPE, ENVELOPE, 1))).toBe(
          'email_change_notices_account_version_check',
        );
        expect(await violated(insert(ENVELOPE, `v12.${'b'.repeat(40)}`))).toBeNull();
        expect(await violated(insert(ENVELOPE, ENVELOPE))).toBe('email_change_notices_pkey');
        expect(
          await violated(
            sql.query(
              `INSERT INTO identity.email_change_notices (market_id, tenant_id, account_id,
                 account_version, previous_email, new_email, created_at)
               VALUES ($1, 'default', $2, 2, $3, $3, now())`,
              [code, randomUUID(), ENVELOPE],
            ),
          ),
        ).toBe('email_change_notices_market_id_account_id_fkey');
      });

      it('lets the application role delete a notice but never update one', async () => {
        const accountId = await storedCustomer();
        await sql.query(
          `INSERT INTO identity.email_change_notices (market_id, tenant_id, account_id,
             account_version, previous_email, new_email, created_at)
           VALUES ($1, 'default', $2, 2, $3, $3, now())`,
          [code, accountId, ENVELOPE],
        );
        await expect(
          sql.query(
            `UPDATE identity.email_change_notices SET new_email = $1 WHERE account_id = $2`,
            [ENVELOPE, accountId],
          ),
        ).rejects.toMatchObject({ code: '42501' });
        const { rowCount } = await sql.query(
          'DELETE FROM identity.email_change_notices WHERE account_id = $1',
          [accountId],
        );
        expect(rowCount).toBe(1);
      });

      it('takes the confirm-email-change link purpose and still refuses an unknown one', async () => {
        const accountId = await storedCustomer();
        const insert = (purpose: string) =>
          sql.query(
            `INSERT INTO identity.one_time_links (id, market_id, tenant_id, account_id, purpose,
               requested_at, version)
             VALUES ($1, $2, 'default', $3, $4, now(), 1)`,
            [randomUUID(), code, accountId, purpose],
          );
        expect(await violated(insert('confirm-email-change'))).toBeNull();
        expect(await violated(insert('change-everything'))).toBe('one_time_links_purpose_check');
      });
    });

    describe('the repository and the store', () => {
      it('stores the pending address at millisecond precision and restores it', async () => {
        const accountId = await storedCustomer();
        expect((await change(accountId, 'Maryam.New@Mailbox.test')).ok).toBe(true);
        const account = await load(accountId);
        expect(account.state.pendingEmail).toEqual(email('Maryam.New@Mailbox.test'));
        expect(account.state.pendingEmailRequestedAt?.epochMilliseconds).toBe(
          NOW.epochMilliseconds,
        );
        // The link carries the same instant at the same precision: the binding holds (R2).
        const confirmed = account.confirmEmailChange({
          requestedAt: NOW,
          now: NOW.add({ minutes: 1 }),
          lifetimeMinutes: 60,
        });
        expect(confirmed.ok).toBe(true);
      });

      it('swaps the address on save, and a clash on the unique key rolls the whole unit back', async () => {
        const target = `${randomUUID()}@mailbox.test`;
        const first = await storedCustomer();
        const second = await storedCustomer();
        expect((await change(first, target)).ok).toBe(true);
        expect((await change(second, target)).ok).toBe(true);

        const confirm = (accountId: Id<'Account'>) =>
          db.unitOfWork.run(market, async () => {
            const account = await accounts.findById(market, accountId);
            const previous = account!.confirmEmailChange({
              requestedAt: NOW,
              now: NOW.add({ minutes: 5 }),
              lifetimeMinutes: 60,
            });
            if (!previous.ok) throw new Error('test: not confirmable');
            await accounts.save(market, account!);
            await store.recordNotice(
              market,
              accountId,
              account!.state.version,
              { previousEmail: previous.value.typed, newEmail: account!.state.email.typed },
              NOW,
            );
            return ok(previous.value.typed);
          });

        expect(await confirm(first)).toMatchObject({ ok: true });
        expect((await load(first)).state.email.normalized).toBe(target);
        await expect(confirm(second)).rejects.toBeInstanceOf(AccountEmailTakenError);
        // Nothing of the refused unit stays: the pending address and no notice.
        const after = await load(second);
        expect(after.state.pendingEmail?.normalized).toBe(target);
        const { rows } = await sql.query(
          'SELECT 1 FROM identity.email_change_notices WHERE account_id = $1',
          [second],
        );
        expect(rows).toEqual([]);
      });

      it('seals one notice per change, opens it by its version and deletes only that one', async () => {
        const accountId = await storedCustomer();
        const first = { previousEmail: 'Previous.Address@Example.com', newEmail: 'B@Mailbox.test' };
        const second = { previousEmail: 'B@Mailbox.test', newEmail: 'C@Mailbox.test' };
        await db.unitOfWork.run(market, async () => {
          await store.recordNotice(market, accountId, 2, first, NOW);
          await store.recordNotice(market, accountId, 3, second, NOW);
          return ok(undefined);
        });
        const { rows } = await sql.query<{ previous_email: string; new_email: string }>(
          'SELECT previous_email, new_email FROM identity.email_change_notices WHERE account_id = $1',
          [accountId],
        );
        expect(rows).toHaveLength(2);
        for (const sealed of rows) {
          expect(sealed.previous_email).toMatch(/^v1\./);
          expect(JSON.stringify(sealed)).not.toMatch(/Previous|Mailbox/);
        }
        const read = (version: number) =>
          db.unitOfWork.run(
            market,
            async () => ok(await store.noticeOf(market, accountId, version)),
            {
              readOnly: true,
            },
          );
        expect(await read(2)).toEqual(ok(first));
        expect(await read(3)).toEqual(ok(second));
        expect(await read(4)).toEqual(ok('missing'));
        const forget = (version: number) =>
          db.unitOfWork.run(market, async () =>
            ok(await store.forgetNotice(market, accountId, version)),
          );
        expect(await forget(2)).toEqual(ok(true));
        expect(await forget(2)).toEqual(ok(false));
        expect(await read(2)).toEqual(ok('missing'));
        expect(await read(3)).toEqual(ok(second));
      });

      it('purges a pending address at the lifetime boundary, with a version step, and not before', async () => {
        const lapsed = await storedCustomer();
        const fresh = await storedCustomer();
        expect((await change(lapsed, `${randomUUID()}@mailbox.test`)).ok).toBe(true);
        expect(
          (await change(fresh, `${randomUUID()}@mailbox.test`, NOW.add({ milliseconds: 1 }))).ok,
        ).toBe(true);
        const before = (await load(lapsed)).state.version;
        const purged = await db.unitOfWork.run(market, async () =>
          ok(await store.clearLapsedPendingEmails(market, NOW)),
        );
        expect(purged.ok && purged.value).toBeGreaterThanOrEqual(1);
        const cleared = await load(lapsed);
        expect(cleared.state.pendingEmail ?? null).toBeNull();
        expect(cleared.state.version).toBe(before + 1);
        expect((await load(fresh)).state.pendingEmail).not.toBeNull();
      });
    });
  });
});
