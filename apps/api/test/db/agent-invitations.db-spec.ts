import { randomBytes } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { Client } from 'pg';
import {
  INVITATION_REPOSITORY,
  InvitationAlreadyPendingError,
  type InvitationRepository,
} from '../../src/modules/identity/application/ports/invitation.repository';
import { parseEmailAddress } from '../../src/modules/identity/domain/email-address';
import { Invitation } from '../../src/modules/identity/domain/invitation';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { createTestApp } from '../support/test-app';
import { TEST_MARKETS } from '../support/test-config';
import { marketOf } from './persistence-support';
import { testDatabaseUrl } from './test-database';

// ADR-0045 on PostgreSQL, for both Market fixtures: the agent invitation row (no role, no seller,
// the reserved account id, the HMAC of the handover code and its failed attempts), the partial
// unique key per address, the CHECKs that keep the agent columns to the agent kind, and the
// population CHECKs that now admit `agent`.

const NOW = Temporal.Instant.from('2026-11-06T10:00:00Z');
const ID_PREFIX = '01990000-0000-7000-8000-';
const newId = <T extends string>(): Id<T> =>
  `${ID_PREFIX}${randomBytes(6).toString('hex')}` as Id<T>;
const HMAC = new Uint8Array(32).fill(4);

describe.each(TEST_MARKETS)('agent invitations in market %s (database, ADR-0045)', (code) => {
  const market = marketOf(code);
  let app: NestExpressApplication;
  let sql: Client;
  let unitOfWork: UnitOfWork;
  let invitations: InvitationRepository;

  beforeAll(async () => {
    ({ app } = await createTestApp({ env: { DATABASE_URL: testDatabaseUrl() } }));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
    unitOfWork = app.get(UNIT_OF_WORK, { strict: false });
    invitations = app.get(INVITATION_REPOSITORY, { strict: false });
  });
  afterAll(async () => {
    await sql.end();
    await app.close();
  });

  const inUnit = <T>(m: MarketContext, work: () => Promise<T>): Promise<T> =>
    unitOfWork
      .run(m, async () => ok(await work()))
      .then((result) => (result as { ok: true; value: T }).value);

  const email = (local: string) => {
    const parsed = parseEmailAddress(`${local}.${randomBytes(4).toString('hex')}@agents.example`);
    if (!parsed.ok) throw new Error('bad email');
    return parsed.value;
  };
  const agentInvitation = (address = email('agent'), inviter = newId<'Account'>()) =>
    Invitation.issueAgent({
      id: newId<'Invitation'>(),
      marketId: market.marketId,
      email: address,
      displayName: 'Agent One',
      agentAccountId: newId<'Account'>(),
      handoverCodeHmac: HMAC,
      invitedByAccountId: inviter,
      now: NOW,
    });

  it('stores and reads back an agent invitation with its code HMAC and counted attempts', async () => {
    const invitation = agentInvitation();
    await inUnit(market, () => invitations.add(market, invitation));

    const loaded = await inUnit(market, () => invitations.findById(market, invitation.state.id));

    expect(loaded!.state).toMatchObject({
      kind: 'agent',
      state: 'pending',
      roleId: null,
      sellerId: null,
      agentAccountId: invitation.state.agentAccountId,
      handoverFailedAttempts: 0,
    });
    expect([...loaded!.state.handoverCodeHmac!]).toEqual([...HMAC]);

    loaded!.dispatch(new Uint8Array(32).fill(8), NOW, 4320);
    loaded!.presentHandoverCode(false, NOW);
    await inUnit(market, () => invitations.save(market, loaded!));
    const counted = await inUnit(market, () => invitations.findById(market, invitation.state.id));
    expect(counted!.state.handoverFailedAttempts).toBe(1);
    expect(counted!.state.version).toBe(loaded!.state.version);
  });

  it('finds the pending invitation by address and by reserved account id, in this Market only', async () => {
    const invitation = agentInvitation();
    await inUnit(market, () => invitations.add(market, invitation));
    const normalized = invitation.state.email!.normalized;
    const accountId = invitation.state.agentAccountId!;

    const byEmail = await inUnit(market, () => invitations.findPendingAgentFor(market, normalized));
    const byAccount = await inUnit(market, () =>
      invitations.findPendingAgentByAccountId(market, accountId),
    );
    const invited = await inUnit(market, () =>
      invitations.agentAccountIdsWithPendingInvitation(market, [accountId, newId<'Account'>()]),
    );

    expect(byEmail!.state.id).toBe(invitation.state.id);
    expect(byAccount!.state.id).toBe(invitation.state.id);
    expect([...invited]).toEqual([accountId]);
    // The admin lookup of the platform scope never returns an agent invitation.
    await expect(
      inUnit(market, () => invitations.findPendingFor(market, null, normalized)),
    ).resolves.toBeNull();
  });

  it('allows one pending agent invitation per address, and an admin one for the same address', async () => {
    const address = email('shared');
    await inUnit(market, () => invitations.add(market, agentInvitation(address)));

    await expect(
      inUnit(market, () => invitations.add(market, agentInvitation(address))),
    ).rejects.toBeInstanceOf(InvitationAlreadyPendingError);

    // An admin invitation to the same address is a different population: no clash.
    const roleId = newId<'Role'>();
    const admin = Invitation.issue({
      id: newId<'Invitation'>(),
      marketId: market.marketId,
      kind: 'admin',
      email: address,
      roleId,
      sellerId: null,
      invitedByAccountId: null,
      now: NOW,
    });
    await inUnit(market, () => invitations.add(market, admin));
    const adminPending = await inUnit(market, () =>
      invitations.findPendingFor(market, null, address.normalized),
    );
    expect(adminPending!.state.kind).toBe('admin');
  });

  it('frees the address once the invitation is revoked', async () => {
    const address = email('revoked');
    const added = agentInvitation(address);
    await inUnit(market, () => invitations.add(market, added));
    const first = (await inUnit(market, () => invitations.findById(market, added.state.id)))!;
    first.revoke(NOW);
    await inUnit(market, () => invitations.save(market, first));

    await inUnit(market, () => invitations.add(market, agentInvitation(address)));
  });

  describe('constraints', () => {
    const insert = (overrides: Record<string, unknown>) => {
      const row = {
        id: newId<'Invitation'>(),
        kind: 'agent',
        role_id: null,
        seller_id: null,
        agent_account_id: newId<'Account'>(),
        handover_code_hmac: Buffer.from(HMAC),
        handover_failed_attempts: 0,
        display_name: 'Agent',
        invited_by_account_id: newId<'Account'>(),
        ...overrides,
      };
      const emailText = `c.${randomBytes(4).toString('hex')}@agents.example`;
      return sql.query(
        `INSERT INTO identity.invitations (id, market_id, tenant_id, kind, email, email_normalized,
           display_name, role_id, seller_id, invited_by_account_id, state, version, created_at,
           agent_account_id, handover_code_hmac, handover_failed_attempts)
         VALUES ($1, $2, 'default', $3, $4, $4, $5, $6, $7, $8, 'pending', 1, now(), $9, $10, $11)`,
        [
          row.id,
          code,
          row.kind,
          emailText,
          row.display_name,
          row.role_id,
          row.seller_id,
          row.invited_by_account_id,
          row.agent_account_id,
          row.handover_code_hmac,
          row.handover_failed_attempts,
        ],
      );
    };

    it('accepts the well-formed agent row', async () => {
      await expect(insert({})).resolves.toBeDefined();
    });

    it.each([
      ['an agent with a role', { role_id: newId<'Role'>() }],
      ['an agent without a reserved account id', { agent_account_id: null }],
      ['a pending agent without a handover code', { handover_code_hmac: null }],
      ['a handover code that is not 32 bytes', { handover_code_hmac: Buffer.alloc(31) }],
      ['more than 5 failed attempts', { handover_failed_attempts: 6 }],
      ['an admin invitation with agent columns', { kind: 'admin', role_id: newId<'Role'>() }],
    ])('refuses %s', async (_case, overrides) => {
      await expect(insert(overrides)).rejects.toMatchObject({ code: '23514' });
    });

    it.each(['accounts', 'sessions', 'sign_in_records'])(
      'admits the agent population in identity.%s and refuses an unknown one',
      async (table) => {
        const { rows } = await sql.query<{ definition: string }>(
          `SELECT pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = 'identity' AND t.relname = $1 AND c.conname = $2`,
          [table, `${table}_population_check`],
        );
        expect(rows[0]!.definition).toContain("'agent'");
        expect(rows[0]!.definition).toContain("'customer'");
      },
    );
  });
});
