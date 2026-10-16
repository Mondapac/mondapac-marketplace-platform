import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id } from '@mondapac/shared-kernel';
import { testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  SESSION_REPOSITORY,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  STEP_UP_REPOSITORY,
  type StepUpRepository,
} from '../../src/modules/identity/application/ports/step-up.repository';
import { openSession } from '../../src/modules/identity/domain/session';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The seller's per-action two-step rules and the fresh-code proofs on PostgreSQL (seller OTP
// policy), for both Market fixtures, as the application role: the rule is stored once per action
// and bumps its version on a change; a proof is replaced in place; proofs go with their session;
// the CHECKs refuse a malformed key; the rows of one seller or session never leak to another.

const CREATED = '2026-10-16T00:00:00Z';
const newId = <T extends string>(): Id<T> =>
  `01990000-0000-7000-8000-${randomBytes(6).toString('hex')}` as Id<T>;
const T0 = Temporal.Instant.from('2026-10-16T10:00:00Z');

describe.each(TEST_MARKETS)('the step-up rules in market %s (database)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let repo: StepUpRepository;
  let units: UnitOfWork;

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    repo = app.get<StepUpRepository>(STEP_UP_REPOSITORY);
    units = app.get<UnitOfWork>(UNIT_OF_WORK);
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const inUnit = <T>(work: () => Promise<T>): Promise<T> =>
    units
      .run(market, async () => ok(await work()))
      .then((result) => {
        if (!result.ok) throw new Error('unit refused');
        return result.value;
      });

  async function seller(): Promise<Id<'Seller'>> {
    const id = newId<'Seller'>();
    await sql.query(
      `INSERT INTO identity.seller_access (seller_id, market_id, tenant_id, origin, state,
       state_changed_at, reapply_count, registered_at, version, created_at)
       VALUES ($1, $2, 'default', 'self', 'approved', $3, 0, $3, 1, $3)`,
      [id, code, CREATED],
    );
    return id;
  }

  async function sessionOf(sellerId: Id<'Seller'>): Promise<Id<'Session'>> {
    const accountId = newId<'Account'>();
    const email = `Member.${accountId}@Shop.example`;
    await sql.query(
      `INSERT INTO identity.accounts (id, market_id, tenant_id, population, email,
       email_normalized, display_name, status, email_verified_at, signed_up_at, version, created_at)
       VALUES ($1, $2, 'default', 'seller', $3, $4, 'Member', 'active', $5, $5, 1, $5)`,
      [accountId, code, email, email.toLowerCase(), CREATED],
    );
    const id = newId<'Session'>();
    await inUnit(() =>
      app.get<SessionRepository>(SESSION_REPOSITORY).add(
        market,
        openSession({
          id,
          marketId: market.marketId,
          accountId,
          population: 'seller',
          sellerId,
          transport: 'cookie',
          lifetime: { idleTimeoutSeconds: 3600, absoluteLifetimeSeconds: 7200 },
          now: Temporal.Now.instant(),
        }),
        new Uint8Array(randomBytes(32)),
      ),
    );
    return id;
  }

  it('stores a rule once per action and bumps its version when it changes', async () => {
    const sellerId = await seller();
    const actor = newId<'Account'>();
    const a = 'pricing.price.change';
    expect(await inUnit(() => repo.policyOf(market, sellerId, a))).toBeNull();

    await inUnit(() => repo.savePolicy(market, sellerId, a, true, actor, T0));
    await inUnit(() => repo.savePolicy(market, sellerId, a, false, actor, T0.add({ minutes: 1 })));
    await inUnit(() => repo.savePolicy(market, sellerId, 'catalog.offer.delete', true, actor, T0));

    expect(await inUnit(() => repo.policyOf(market, sellerId, a))).toBe(false);
    const rows = await inUnit(() => repo.policiesOf(market, sellerId));
    expect(rows.map((r) => [r.actionKey, r.required])).toEqual([
      ['catalog.offer.delete', true],
      ['pricing.price.change', false],
    ]);
    expect(rows[1]!.updatedAt.toString()).toBe(T0.add({ minutes: 1 }).toString());
    const { rows: stored } = await sql.query<{ version: number; updated_by_account_id: string }>(
      `SELECT version, updated_by_account_id FROM identity.seller_step_up_policies
       WHERE market_id = $1 AND seller_id = $2 AND action_key = $3`,
      [code, sellerId, a],
    );
    expect(stored).toEqual([{ version: 2, updated_by_account_id: actor }]);
  });

  it("never shows one seller's rules to another", async () => {
    const [one, two] = [await seller(), await seller()];
    await inUnit(() => repo.savePolicy(market, one, 'pricing.price.change', true, newId(), T0));

    expect(await inUnit(() => repo.policiesOf(market, two))).toEqual([]);
    expect(await inUnit(() => repo.policyOf(market, two, 'pricing.price.change'))).toBeNull();
  });

  it('replaces a proof in place, keeps one per session and action, and ends it with the session', async () => {
    const sellerId = await seller();
    const session = await sessionOf(sellerId);
    const other = await sessionOf(sellerId);
    const a = 'sellers.store-terms.change';
    expect(await inUnit(() => repo.proofOf(market, session, a))).toBeNull();

    await inUnit(() => repo.recordProof(market, session, a, T0));
    await inUnit(() => repo.recordProof(market, session, a, T0.add({ minutes: 3 })));

    expect((await inUnit(() => repo.proofOf(market, session, a)))!.toString()).toBe(
      T0.add({ minutes: 3 }).toString(),
    );
    expect(await inUnit(() => repo.proofOf(market, other, a))).toBeNull();
    expect(await inUnit(() => repo.proofOf(market, session, 'pricing.price.change'))).toBeNull();
    const count = () =>
      sql.query<{ n: string }>(
        `SELECT count(*) AS n FROM identity.step_up_proofs WHERE market_id = $1 AND session_id = $2`,
        [code, session],
      );
    expect((await count()).rows[0]!.n).toBe('1');

    await sql.query(`DELETE FROM identity.sessions WHERE market_id = $1 AND id = $2`, [
      code,
      session,
    ]);
    expect((await count()).rows[0]!.n).toBe('0');
  });

  it('refuses a malformed action key, a bad version and a proof for an unknown session', async () => {
    const sellerId = await seller();
    const insert = (key: string, version = 1) =>
      sql.query(
        `INSERT INTO identity.seller_step_up_policies (market_id, tenant_id, seller_id,
         action_key, required, updated_by_account_id, updated_at, version)
         VALUES ($1, 'default', $2, $3, true, $4, $5, $6)`,
        [code, sellerId, key, randomUUID(), CREATED, version],
      );

    await expect(insert('Pricing.Price')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('pricing')).rejects.toMatchObject({ code: '23514' });
    await expect(insert('pricing.price.change', 0)).rejects.toMatchObject({ code: '23514' });
    await expect(
      inUnit(() => repo.recordProof(market, newId<'Session'>(), 'pricing.price.change', T0)),
    ).rejects.toBeDefined();
    await expect(
      inUnit(() =>
        repo.savePolicy(market, newId<'Seller'>(), 'pricing.price.change', true, newId(), T0),
      ),
    ).rejects.toBeDefined();
  });
});
