import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { fakeHashOf, IdentityFakes } from '../../../../../test/support/identity-fakes';
import {
  TEST_MARKETS,
  TEST_MARKET_CONFIG_DIRS,
  TEST_MARKET_IDS,
} from '../../../../../test/support/test-config';
import { createUseCaseGate } from '../../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../../platform/market-config/market-registry';
import { PLATFORM_TENANT_ID } from '../../../../platform/market-context/tenant';
import { AGENTS_MANAGE_KEY, AGENTS_READ_KEY } from '../../contracts/agent-access';
import { AGENT_ACCOUNT_RESET_SECOND_FACTOR } from '../../contracts/permissions';
import { SecondFactor } from '../../domain/second-factor';
import type { AccountState } from '../../domain/account';
import { HmacHandoverCodes } from '../../infrastructure/second-factor/hmac-handover-codes';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AgentAccessOf } from './agent-access-of.use-case';
import { ContactEmailOf } from './contact-email-of.use-case';
import { DisableAgentAccount } from './disable-agent-account.use-case';
import { EnableAgentAccount } from './enable-agent-account.use-case';
import { IssueAgentInvitation } from './issue-agent-invitation.use-case';
import { ResetAgentSecondFactor } from './reset-agent-second-factor.use-case';

// ADR-0045 decision 5 and the facade rows of the agents design: disable (sessions revoked, open
// invitation voided, one unit), enable, the live access read, and the agent contact address.
// Both Market fixtures.

const START = Temporal.Instant.from('2026-11-06T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const uuid = (n: number) => `01990000-0000-7000-8000-${n12(n)}`;
const MANAGER = id<'Account'>(uuid(0xa001));
const READER = id<'Account'>(uuid(0xa002));
const NO_KEY = id<'Account'>(uuid(0xa003));
const AGENT = id<'Account'>(uuid(0xb001));
const CUSTOMER = id<'Account'>(uuid(0xb002));
const UNKNOWN = id<'Account'>(uuid(0xb0ff));
const ROLE = id<'Role'>(uuid(0xc001));
const SESSION_ID = id<'Session'>(uuid(0xf001));

describe.each(TEST_MARKETS)('agent accounts in market %s (ADR-0045)', (code) => {
  const market: MarketContext = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const policy = new MarketConfigIdentityPolicy(markets);
  let fakes: IdentityFakes;
  let clock: FixedClock;

  const effectiveKeys: EffectiveKeyResolver = (subject) =>
    new Set(
      subject.accountId === MANAGER
        ? [AGENTS_MANAGE_KEY, AGENT_ACCOUNT_RESET_SECOND_FACTOR.key]
        : subject.accountId === READER
          ? [AGENTS_READ_KEY]
          : [],
    );

  function setUp() {
    fakes = new IdentityFakes();
    clock = new FixedClock(START);
    fakes.seedRole({
      id: ROLE,
      marketId,
      scope: 'platform',
      kind: 'custom',
      seedCode: null,
      seedVersion: null,
      sellerId: null,
      name: 'Agents role',
      permissionKeys: [],
      version: 1,
      createdAt: START,
    });
    const account = (
      idOf: Id<'Account'>,
      population: AccountState['population'],
      n: number,
      status: AccountState['status'] = 'active',
    ) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `A${n}@Example.com`, normalized: `a${n}@example.com` },
        displayName: population === 'customer' ? null : `Account ${n}`,
        status,
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    for (const [n, idOf] of [
      [1, MANAGER],
      [2, READER],
      [3, NO_KEY],
    ] as const) {
      account(idOf, 'admin', n);
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(uuid(0xe100 + n)),
        marketId,
        accountId: idOf,
        roleId: ROLE,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    account(AGENT, 'agent', 4);
    account(CUSTOMER, 'customer', 5);
    const gate = createUseCaseGate(
      markets,
      new AccountAuthorisationCheck({
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        sellerAccess: fakes.sellerAccessRepository,
        grants: fakes.grantReader,
        effectiveKeys,
      }),
    );
    const status = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      invitations: fakes.invitationRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      sessions: fakes.sessionRepository,
      challenges: fakes.challengeRepository,
      outbox: fakes.outbox,
      audit: fakes.audit,
      clock,
    };
    return {
      disable: new DisableAgentAccount(gate, status),
      enable: new EnableAgentAccount(gate, status),
      access: new AgentAccessOf(gate, status),
      contact: new ContactEmailOf(gate, {
        unitOfWork: fakes.unitOfWork,
        accounts: fakes.accountRepository,
        memberships: fakes.membershipRepository,
        grants: fakes.grantReader,
      }),
      reset: new ResetAgentSecondFactor(gate, { ...status, factors: fakes.factorRepository }),
      issue: new IssueAgentInvitation(gate, {
        ...status,
        throttles: fakes.throttleRepository,
        keys,
        policy,
        codes: new HmacHandoverCodes(new Uint8Array(32).fill(9)),
        ids: new SequenceIdGenerator(clock),
      }),
    };
  }

  const as = (account: Id<'Account'>, population: 'admin' | 'customer' | 'agent' = 'admin') =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population,
        accountId: account,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
      'agent-account-0001',
    );
  const system = () => testCallContext(market, 'system', 'agent-account-0002');

  function openSession(sessionId: string, accountId: Id<'Account'>) {
    fakes.sessions.set(sessionId, {
      tokenHash: sessionId,
      session: {
        id: id<'Session'>(sessionId),
        marketId,
        accountId,
        population: 'agent',
        sellerId: null,
        transport: 'cookie',
        device: null,
        createdAt: START,
        lastSeenAt: START,
        idleTimeoutSeconds: 1800,
        absoluteExpiresAt: START.add({ hours: 12 }),
        revokedAt: null,
        revokedReason: null,
      },
    });
  }
  const liveSessions = () =>
    [...fakes.sessions.values()].filter((entry) => entry.session.revokedAt === null).length;

  describe('disableAgentAccount', () => {
    it('disables the account and revokes every session of the agent', async () => {
      const useCases = setUp();
      openSession(uuid(0xf101), AGENT);
      openSession(uuid(0xf102), AGENT);

      const result = await useCases.disable.execute(as(MANAGER), { accountId: AGENT });

      expect(result).toMatchObject({
        ok: true,
        value: { code: 'agent.disabled', accountId: AGENT, revokedSessions: 2 },
      });
      expect(fakes.accounts.get(AGENT)!.status).toBe('disabled');
      expect(liveSessions()).toBe(0);
      expect(fakes.audits.map((a) => a.action)).toContain('identity.account.disabled');
    });

    it('is idempotent: a second disable answers the same success and changes nothing more', async () => {
      const useCases = setUp();
      await useCases.disable.execute(as(MANAGER), { accountId: AGENT });
      const audits = fakes.audits.length;

      const again = await useCases.disable.execute(as(MANAGER), { accountId: AGENT });

      expect(again).toMatchObject({
        ok: true,
        value: { code: 'agent.disabled', revokedSessions: 0 },
      });
      expect(fakes.audits).toHaveLength(audits);
    });

    it('voids the open invitation of an agent who never accepted', async () => {
      const useCases = setUp();
      const issued = await useCases.issue.execute(as(MANAGER), {
        email: 'new.agent@example.com',
        displayName: 'New Agent',
      });
      if (!issued.ok) throw new Error(issued.error.code);

      const result = await useCases.disable.execute(as(MANAGER), {
        accountId: issued.value.accountId,
      });

      expect(result).toMatchObject({ ok: true, value: { voidedInvitations: 1 } });
      expect(fakes.invitations.get(issued.value.invitationId)).toMatchObject({
        state: 'revoked',
        handoverCodeHmac: null,
      });
    });

    it.each([
      ['an account of another population', CUSTOMER],
      ['an id that is nothing', UNKNOWN],
    ])('answers agent.unknown for %s, and changes nothing', async (_label, target) => {
      const useCases = setUp();

      const result = await useCases.disable.execute(as(MANAGER), { accountId: target });

      expect(result).toEqual({ ok: false, error: { code: 'agent.unknown' } });
      expect(fakes.accounts.get(CUSTOMER)!.status).toBe('active');
    });

    it.each([
      ['an admin without agents.agent.manage', () => as(NO_KEY)],
      ['an admin with only agents.agent.read', () => as(READER)],
      ['a customer', () => as(CUSTOMER, 'customer')],
      ['an agent', () => as(AGENT, 'agent')],
      ['an anonymous caller', () => testCallContext(market, 'anonymous', 'agent-account-0003')],
    ])('refuses %s', async (_label, context) => {
      const useCases = setUp();
      openSession(uuid(0xf101), AGENT);

      const result = await useCases.disable.execute(context(), { accountId: AGENT });

      expect(result.ok).toBe(false);
      expect(fakes.accounts.get(AGENT)!.status).toBe('active');
      expect(liveSessions()).toBe(1);
    });
  });

  describe('enableAgentAccount', () => {
    it('enables a disabled agent and brings no session or invitation back', async () => {
      const useCases = setUp();
      openSession(uuid(0xf101), AGENT);
      await useCases.disable.execute(as(MANAGER), { accountId: AGENT });

      const result = await useCases.enable.execute(as(MANAGER), { accountId: AGENT });

      expect(result).toMatchObject({
        ok: true,
        value: { code: 'agent.enabled', accountId: AGENT },
      });
      expect(fakes.accounts.get(AGENT)!.status).toBe('active');
      expect(liveSessions()).toBe(0);
    });

    it('is idempotent for an active agent', async () => {
      const useCases = setUp();

      const result = await useCases.enable.execute(as(MANAGER), { accountId: AGENT });

      expect(result).toMatchObject({ ok: true, value: { code: 'agent.enabled' } });
      expect(fakes.audits).toHaveLength(0);
    });

    it('answers agent.unknown for a customer account and refuses a caller without the key', async () => {
      const useCases = setUp();

      expect(await useCases.enable.execute(as(MANAGER), { accountId: CUSTOMER })).toEqual({
        ok: false,
        error: { code: 'agent.unknown' },
      });
      expect((await useCases.enable.execute(as(NO_KEY), { accountId: AGENT })).ok).toBe(false);
    });
  });

  describe('agentAccessOf', () => {
    it('answers active, disabled and invited from live rows; other ids are absent', async () => {
      const useCases = setUp();
      const issued = await useCases.issue.execute(as(MANAGER), {
        email: 'new.agent@example.com',
        displayName: 'New Agent',
      });
      if (!issued.ok) throw new Error(issued.error.code);
      const disabled = id<'Account'>(uuid(0xb003));
      fakes.seedAccount({
        ...fakes.accounts.get(AGENT)!,
        id: disabled,
        status: 'disabled',
        email: { typed: 'd@example.com', normalized: 'd@example.com' },
      });

      const result = await useCases.access.execute(as(READER), {
        accountIds: [AGENT, disabled, issued.value.accountId, CUSTOMER, UNKNOWN],
      });

      if (!result.ok) throw new Error(result.error.code);
      expect([...result.value]).toEqual(
        expect.arrayContaining([
          [AGENT, 'active'],
          [disabled, 'disabled'],
          [issued.value.accountId, 'invited'],
        ]),
      );
      expect(result.value.size).toBe(3);
    });

    it('reads a disable at once, with no event in between', async () => {
      const useCases = setUp();
      await useCases.disable.execute(as(MANAGER), { accountId: AGENT });

      const result = await useCases.access.execute(as(MANAGER), { accountIds: [AGENT] });

      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.get(AGENT)).toBe('disabled');
    });

    it('refuses more than 500 ids, a caller without either key and a non-admin', async () => {
      const useCases = setUp();
      const many = Array.from({ length: 501 }, (_, i) => id<'Account'>(uuid(0x10000 + i)));

      expect((await useCases.access.execute(as(MANAGER), { accountIds: many })).ok).toBe(false);
      expect((await useCases.access.execute(as(NO_KEY), { accountIds: [AGENT] })).ok).toBe(false);
      expect(
        (await useCases.access.execute(as(CUSTOMER, 'customer'), { accountIds: [AGENT] })).ok,
      ).toBe(false);
    });
  });

  describe('ResetAgentSecondFactor', () => {
    const seedFactor = (accountId: Id<'Account'>) => {
      const factor = SecondFactor.createActive({
        id: id<'SecondFactor'>(uuid(0xd001)),
        marketId,
        accountId,
        secretCiphertext: 'sealed',
        acceptedStep: 1,
        recoveryCodeHashes: Array.from({ length: 10 }, (_, i) => new Uint8Array(32).fill(i + 1)),
        now: START,
      });
      fakes.factors.set(accountId, factor.state);
    };

    it('removes the factor, revokes every session, voids challenges, audits and opens no session', async () => {
      const useCases = setUp();
      seedFactor(AGENT);
      openSession(uuid(0xf101), AGENT);

      const result = await useCases.reset.execute(as(MANAGER), { accountId: AGENT });

      expect(result).toMatchObject({
        ok: true,
        value: { code: 'second-factor.reset', accountId: AGENT, revokedSessions: 1 },
      });
      expect(fakes.factors.has(AGENT)).toBe(false);
      expect(liveSessions()).toBe(0);
      expect(fakes.audits.map((a) => a.action)).toContain('identity.second-factor.reset');
      expect(fakes.events.map((e) => e.type)).toContain('identity.second-factor-changed.v1');
    });

    it('answers second-factor.none without a factor, and account.unknown for a non-agent', async () => {
      const useCases = setUp();
      seedFactor(CUSTOMER);

      expect(await useCases.reset.execute(as(MANAGER), { accountId: AGENT })).toEqual({
        ok: false,
        error: { code: 'second-factor.none' },
      });
      expect(await useCases.reset.execute(as(MANAGER), { accountId: CUSTOMER })).toEqual({
        ok: false,
        error: { code: 'account.unknown' },
      });
      expect(fakes.factors.has(CUSTOMER)).toBe(true);
    });

    it.each([
      ['an admin holding only agents.agent.manage', () => as(READER)],
      ['an admin without the key', () => as(NO_KEY)],
      ['an agent', () => as(AGENT, 'agent')],
      ['a customer', () => as(CUSTOMER, 'customer')],
    ])('refuses %s and changes nothing', async (_label, context) => {
      const useCases = setUp();
      seedFactor(AGENT);
      openSession(uuid(0xf101), AGENT);

      const result = await useCases.reset.execute(context(), { accountId: AGENT });

      expect(result.ok).toBe(false);
      expect(fakes.factors.has(AGENT)).toBe(true);
      expect(liveSessions()).toBe(1);
    });
  });

  describe('contactEmailOf for an agent', () => {
    it('answers the address of an active, verified agent to the system only', async () => {
      const useCases = setUp();

      expect(await useCases.contact.execute(system(), { kind: 'agent', accountId: AGENT })).toEqual(
        {
          ok: true,
          value: 'A4@Example.com',
        },
      );
      expect(
        (await useCases.contact.execute(as(MANAGER), { kind: 'agent', accountId: AGENT })).ok,
      ).toBe(false);
    });

    it('answers null for a disabled agent, a customer id and an unknown id alike', async () => {
      const useCases = setUp();
      await useCases.disable.execute(as(MANAGER), { accountId: AGENT });

      for (const target of [AGENT, CUSTOMER, UNKNOWN]) {
        expect(
          await useCases.contact.execute(system(), { kind: 'agent', accountId: target }),
        ).toEqual({
          ok: true,
          value: null,
        });
      }
    });
  });
});
