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
import { AGENTS_MANAGE_KEY } from '../../contracts/agent-access';
import { parseEmailAddress } from '../../domain/email-address';
import { Invitation } from '../../domain/invitation';
import type { AccountState } from '../../domain/account';
import { candidateSteps } from '../../domain/totp';
import { HmacHandoverCodes } from '../../infrastructure/second-factor/hmac-handover-codes';
import {
  HmacEnrolmentSecretTags,
  INVITATION_TOKEN_PREFIX,
  RandomPrefixedTokens,
} from '../../infrastructure/second-factor/second-factor-tokens';
import { hotp } from '../../infrastructure/second-factor/totp';
import { MarketConfigIdentityPolicy } from '../../infrastructure/market-config-identity-policy';
import { AccountAuthorisationCheck } from '../access/account-authorisation-check';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { ThrottleKeys } from '../ports/session-secrets';
import { AcceptAgentInvitation } from './accept-agent-invitation.use-case';
import { IssueAgentInvitation } from './issue-agent-invitation.use-case';
import { ReissueAgentInvitation } from './reissue-agent-invitation.use-case';
import { RevokeAgentInvitation } from './revoke-agent-invitation.use-case';
import { StartAgentInvitationAcceptance } from './start-agent-invitation-acceptance.use-case';

// ADR-0045 decision 2 and 3: the agent invitation with its handover code, revoke and reissue,
// and the one-request acceptance. The real gate, policy and domain; identity's stores as fakes.
// Both Market fixtures.

const START = Temporal.Instant.from('2026-11-06T10:00:00Z');
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const keys: ThrottleKeys = {
  account: (market, population, email) => Buffer.from(`${market.marketId}|${population}|${email}`),
  accountOrigin: (market, population, email, origin) =>
    Buffer.from(`${market.marketId}|${population}|${email}|${origin}`),
  origin: (market, origin) => Buffer.from(`${market.marketId}|${origin}`),
};
const CLIENT = { origin: '203.0.113.9', address: '203.0.113.9' };
const PASSWORD = 'correct horse battery staple';
const STACK_SECRET = new Uint8Array(32).fill(9);

const id = <T extends string>(text: string): Id<T> => {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const email = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};
const n12 = (n: number) => String(n).padStart(12, '0');
const ADMIN = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa001)}`);
const ADMIN_WITHOUT_KEY = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa002)}`);
const CUSTOMER = id<'Account'>(`01990000-0000-7000-8000-${n12(0xa003)}`);
const SESSION_ID = id<'Session'>('01990000-0000-7000-8000-00000000f001');
const ROLE = id<'Role'>('01990000-0000-7000-8000-00000000c001');

describe.each(TEST_MARKETS)('agent invitations in market %s (ADR-0045)', (code) => {
  const market: MarketContext = testMarketContext(code, PLATFORM_TENANT_ID);
  const marketId = code as AccountState['marketId'];
  const policy = new MarketConfigIdentityPolicy(markets);
  const lifetime = policy.invitationLifetimeMinutes(market, 'agent')!;
  const tokens = new RandomPrefixedTokens(INVITATION_TOKEN_PREFIX);
  const tags = new HmacEnrolmentSecretTags(STACK_SECRET);
  const codes = new HmacHandoverCodes(STACK_SECRET);
  let fakes: IdentityFakes;
  let clock: FixedClock;

  /** Only ADMIN holds `agents.agent.manage`; ADMIN_WITHOUT_KEY is an admin without it. */
  const effectiveKeys: EffectiveKeyResolver = (subject) =>
    new Set(subject.accountId === ADMIN ? [AGENTS_MANAGE_KEY] : []);

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
    const account = (idOf: Id<'Account'>, population: AccountState['population'], n: number) =>
      fakes.seedAccount({
        id: idOf,
        marketId,
        population,
        email: { typed: `a${n}@example.com`, normalized: `a${n}@example.com` },
        displayName: population === 'customer' ? null : `Account ${n}`,
        status: 'active',
        emailVerifiedAt: START,
        existingAccountNoticeAt: null,
        signedUpAt: START,
        createdAt: START,
        version: 1,
        credential: { passwordHash: fakeHashOf('x'), changedAt: START },
      });
    for (const [n, idOf] of [
      [1, ADMIN],
      [2, ADMIN_WITHOUT_KEY],
    ] as const) {
      account(idOf, 'admin', n);
      fakes.seedAssignment({
        id: id<'RoleAssignment'>(`01990000-0000-7000-8000-${n12(0xe100 + n)}`),
        marketId,
        accountId: idOf,
        roleId: ROLE,
        assignedByAccountId: null,
        assignedAt: START,
        version: 1,
      });
    }
    account(CUSTOMER, 'customer', 3);

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
    const manage = {
      unitOfWork: fakes.unitOfWork,
      accounts: fakes.accountRepository,
      invitations: fakes.invitationRepository,
      grants: fakes.grantReader,
      effectiveKeys,
      throttles: fakes.throttleRepository,
      keys,
      outbox: fakes.outbox,
      audit: fakes.audit,
      policy,
      codes,
      clock,
      ids: new SequenceIdGenerator(clock),
    };
    const acceptance = {
      unitOfWork: fakes.unitOfWork,
      invitations: fakes.invitationRepository,
      throttles: fakes.throttleRepository,
      keys,
      invitationTokens: tokens,
      secrets: fakes.secrets,
      enrolmentTags: tags,
      policy,
      clock,
    };
    return {
      issue: new IssueAgentInvitation(gate, manage),
      revoke: new RevokeAgentInvitation(gate, manage),
      reissue: new ReissueAgentInvitation(gate, manage),
      start: new StartAgentInvitationAcceptance(gate, acceptance),
      accept: new AcceptAgentInvitation(gate, {
        ...acceptance,
        accounts: fakes.accountRepository,
        factors: fakes.factorRepository,
        codes,
        hasher: {
          hash: (password: string) => Promise.resolve({ ok: true, value: fakeHashOf(password) }),
        } as never,
        commonPasswords: { isCommon: () => false },
        outbox: fakes.outbox,
        audit: fakes.audit,
        ids: new SequenceIdGenerator(clock),
      }),
    };
  }

  const as = (account: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: account === CUSTOMER ? 'customer' : 'admin',
        accountId: account,
        sessionId: SESSION_ID,
        sellerId: null,
      }),
      'agent-invite-0001',
    );
  const anonymous = () => testCallContext(market, 'anonymous', 'agent-accept-0001');
  const eventTypes = () => fakes.events.map((event) => event.type);

  type UseCases = ReturnType<typeof setUp>;
  /** Issues an invitation and dispatches it as the mail handler would. */
  async function issued(useCases: UseCases, email = 'agent.one@example.com') {
    const result = await useCases.issue.execute(as(ADMIN), { email, displayName: 'Agent One' });
    if (!result.ok) throw new Error(result.error.code);
    const stored = fakes.invitations.get(result.value.invitationId)!;
    const minted = tokens.issue();
    fakes.invitations.set(result.value.invitationId, {
      ...stored,
      tokenHash: minted.tokenHash,
      expiresAt: START.add({ minutes: lifetime }),
      version: stored.version + 1,
    });
    return { ...result.value, token: minted.token };
  }

  const codeOf = (secret: Uint8Array) => {
    const step = candidateSteps(clock.now())[0]!;
    return hotp(secret, step);
  };

  /** One accepting request with the secret of the preview. */
  async function acceptWith(
    useCases: UseCases,
    token: string,
    handoverCode: string,
    overrides: { password?: string; client?: { origin: string; address: string } } = {},
  ) {
    const preview = await useCases.start.execute(anonymous(), { token, client: CLIENT });
    if (!preview.ok) throw new Error(preview.error.code);
    return useCases.accept.execute(anonymous(), {
      token,
      handoverCode,
      password: overrides.password ?? PASSWORD,
      secret: preview.value.secret,
      tag: preview.value.tag,
      expiresAt: preview.value.expiresAt.toString(),
      code: codeFromBase32(preview.value.secret),
      client: overrides.client ?? CLIENT,
    });
  }
  const codeFromBase32 = (base32: string) => {
    const secret = fromBase32(base32);
    return codeOf(secret);
  };

  describe('issue', () => {
    it('returns the reserved account id, the invitation id and a handover code shown once', async () => {
      const useCases = setUp();

      const result = await useCases.issue.execute(as(ADMIN), {
        email: 'Agent.One@Example.com',
        displayName: 'Agent One',
      });

      if (!result.ok) throw new Error(result.error.code);
      expect(result.value.handoverCode).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
      const stored = fakes.invitations.get(result.value.invitationId)!;
      expect(stored).toMatchObject({
        kind: 'agent',
        state: 'pending',
        agentAccountId: result.value.accountId,
        invitedByAccountId: ADMIN,
        roleId: null,
        sellerId: null,
        handoverFailedAttempts: 0,
        tokenHash: null,
      });
      // Only the HMAC is stored, bound to this invitation: the code is nowhere in the state.
      expect(
        JSON.stringify(stored, (_k, v: unknown) => (v instanceof Uint8Array ? [...v] : v)),
      ).not.toContain(result.value.handoverCode.replace('-', ''));
      expect(
        codes.matches(
          market,
          result.value.invitationId,
          result.value.handoverCode.replace('-', ''),
          stored.handoverCodeHmac!,
        ),
      ).toBe(true);
      expect(eventTypes()).toEqual(['identity.invitation-issued.v1']);
      expect(fakes.audits.map((a) => a.action)).toEqual(['identity.agent-invitation.issued']);
      // The audit holds the inviter as the actor and never the code.
      expect(JSON.stringify(fakes.audits)).not.toContain(result.value.handoverCode);
    });

    it('makes a different code and account id every time', async () => {
      const useCases = setUp();

      const first = await useCases.issue.execute(as(ADMIN), {
        email: 'a1@x.test',
        displayName: 'A One',
      });
      const second = await useCases.issue.execute(as(ADMIN), {
        email: 'a2@x.test',
        displayName: 'A Two',
      });

      if (!first.ok || !second.ok) throw new Error('issue failed');
      expect(first.value.handoverCode).not.toBe(second.value.handoverCode);
      expect(first.value.accountId).not.toBe(second.value.accountId);
    });

    it('is refused to an admin without agents.agent.manage, and to a customer', async () => {
      const useCases = setUp();

      await expect(
        useCases.issue.execute(as(ADMIN_WITHOUT_KEY), { email: 'a@x.test', displayName: 'A' }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      const customer = await useCases.issue.execute(as(CUSTOMER), {
        email: 'a@x.test',
        displayName: 'A',
      });
      expect(customer.ok).toBe(false);
      expect(fakes.invitations.size).toBe(0);
    });

    it('answers invitation.already-pending for a live invitation and for an existing agent', async () => {
      const useCases = setUp();
      await issued(useCases);

      await expect(
        useCases.issue.execute(as(ADMIN), {
          email: 'AGENT.ONE@example.com',
          displayName: 'Agent One',
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.already-pending' } });
      fakes.accounts.set(CUSTOMER, {
        ...fakes.accounts.get(CUSTOMER)!,
        population: 'agent',
        displayName: 'X',
      });
      await expect(
        useCases.issue.execute(as(ADMIN), { email: 'a3@example.com', displayName: 'X' }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.already-pending' } });
    });

    it('replaces a stale pending invitation, voiding its code', async () => {
      const useCases = setUp();
      const first = await issued(useCases);
      clock.advance(Temporal.Duration.from({ minutes: lifetime }));

      const second = await useCases.issue.execute(as(ADMIN), {
        email: 'agent.one@example.com',
        displayName: 'Agent One',
      });

      if (!second.ok) throw new Error(second.error.code);
      expect(fakes.invitations.get(first.invitationId)).toMatchObject({
        state: 'revoked',
        handoverCodeHmac: null,
      });
      expect(second.value.accountId).not.toBe(first.accountId);
    });

    it('validates the address and the name, and needs a configured lifetime', async () => {
      const useCases = setUp();

      const bad = await useCases.issue.execute(as(ADMIN), { email: 'nope', displayName: '' });

      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(fakes.invitations.size).toBe(0);
    });
  });

  describe('revoke and reissue', () => {
    it('revokes a pending agent invitation and clears its code and address', async () => {
      const useCases = setUp();
      const { invitationId } = await issued(useCases);

      await expect(useCases.revoke.execute(as(ADMIN), { invitationId })).resolves.toEqual({
        ok: true,
        value: { code: 'invitation.revoked' },
      });

      expect(fakes.invitations.get(invitationId)).toMatchObject({
        state: 'revoked',
        email: null,
        displayName: null,
        handoverCodeHmac: null,
      });
      expect(fakes.audits.at(-1)!.action).toBe('identity.agent-invitation.revoked');
      expect(eventTypes()).toContain('identity.invitation-revoked.v1');
    });

    it('never revokes an invitation of another kind, nor one that is unknown', async () => {
      const useCases = setUp();
      const adminInvitation = Invitation.issue({
        id: id<'Invitation'>('01990000-0000-7000-8000-0000000000aa'),
        marketId,
        kind: 'admin',
        email: email('someone@example.com'),
        roleId: ROLE,
        sellerId: null,
        invitedByAccountId: ADMIN,
        now: START,
      });
      fakes.invitations.set(adminInvitation.state.id, adminInvitation.state);
      const invitationId = adminInvitation.state.id;

      await expect(useCases.revoke.execute(as(ADMIN), { invitationId })).resolves.toEqual({
        ok: false,
        error: { code: 'invitation.not-found' },
      });
      await expect(
        useCases.revoke.execute(as(ADMIN), {
          invitationId: id<'Invitation'>('01990000-0000-7000-8000-0000000000ff'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.not-found' } });
    });

    it('is refused without agents.agent.manage', async () => {
      const useCases = setUp();
      const { invitationId } = await issued(useCases);

      await expect(
        useCases.revoke.execute(as(ADMIN_WITHOUT_KEY), { invitationId }),
      ).resolves.toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(fakes.invitations.get(invitationId)!.state).toBe('pending');
    });

    it('reissues with a new code and link for the same account id, voiding the old ones', async () => {
      const useCases = setUp();
      const first = await issued(useCases);

      const again = await useCases.reissue.execute(as(ADMIN), { accountId: first.accountId });

      if (!again.ok) throw new Error(again.error.code);
      expect(again.value.accountId).toBe(first.accountId);
      expect(again.value.invitationId).not.toBe(first.invitationId);
      expect(again.value.handoverCode).not.toBe(first.handoverCode);
      expect(fakes.invitations.get(first.invitationId)!.state).toBe('revoked');
      expect(fakes.invitations.get(again.value.invitationId)).toMatchObject({
        state: 'pending',
        agentAccountId: first.accountId,
        displayName: 'Agent One',
      });
      // The old link and code are dead.
      const old = await useCases.start.execute(anonymous(), { token: first.token, client: CLIENT });
      expect(old).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
    });

    it('has nothing to reissue once accepted or unknown', async () => {
      const useCases = setUp();

      await expect(
        useCases.reissue.execute(as(ADMIN), {
          accountId: id<'Account'>('01990000-0000-7000-8000-0000000000fe'),
        }),
      ).resolves.toEqual({ ok: false, error: { code: 'invitation.not-found' } });
    });
  });

  describe('acceptance in one request', () => {
    it('needs the link token and the handover code together, then creates the account without a session', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      const accepted = await acceptWith(useCases, invite.token, invite.handoverCode);

      if (!accepted.ok) throw new Error(accepted.error.code);
      expect(accepted.value.accountId).toBe(invite.accountId);
      expect(accepted.value.recoveryCodes).toHaveLength(10);
      expect(fakes.accounts.get(invite.accountId)).toMatchObject({
        population: 'agent',
        status: 'active',
        displayName: 'Agent One',
      });
      expect(
        [...fakes.factors.values()].filter((f) => f.accountId === invite.accountId),
      ).toHaveLength(1);
      expect(fakes.invitations.get(invite.invitationId)).toMatchObject({
        state: 'accepted',
        acceptedAccountId: invite.accountId,
        email: null,
        displayName: null,
        handoverCodeHmac: null,
      });
      // Opens no session: the agent signs in afterwards, with the second factor.
      expect(fakes.sessions.size).toBe(0);
      expect(eventTypes()).toEqual(
        expect.arrayContaining([
          'identity.invitation-accepted.v1',
          'identity.second-factor-changed.v1',
        ]),
      );
      const audit = fakes.audits.find((a) => a.action === 'identity.agent-invitation.accepted')!;
      expect(audit.after).toMatchObject({ invitedByAccountId: ADMIN, accountId: invite.accountId });
      expect(JSON.stringify(fakes.audits)).not.toContain(invite.handoverCode);
    });

    it('accepts the code in any case, spacing or hyphen', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      const accepted = await acceptWith(
        useCases,
        invite.token,
        ` ${invite.handoverCode.toLowerCase().replace('-', ' ')} `,
      );

      expect(accepted.ok).toBe(true);
    });

    it('refuses the link token alone (a wrong code) and counts the failure', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      const refused = await acceptWith(useCases, invite.token, 'AAAAA-AAAAA');

      expect(refused).toEqual({ ok: false, error: { code: 'handover-code.invalid' } });
      expect(fakes.accounts.has(invite.accountId)).toBe(false);
      expect(fakes.invitations.get(invite.invitationId)).toMatchObject({
        state: 'pending',
        handoverFailedAttempts: 1,
      });
    });

    it('refuses the handover code alone: a wrong or unknown link token', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);
      const stranger = tokens.issue().token;

      const refused = await acceptWith(useCases, invite.token, invite.handoverCode).catch(
        () => null,
      );
      expect(refused?.ok).toBe(true);
      const other = await issued(useCases, 'second@example.com');
      const result = await useCases.accept.execute(anonymous(), {
        token: stranger,
        handoverCode: other.handoverCode,
        password: PASSWORD,
        secret: 'A'.repeat(32),
        tag: 'x'.repeat(43),
        expiresAt: START.add({ minutes: 5 }).toString(),
        code: '123456',
        client: CLIENT,
      });

      expect(result).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect(fakes.accounts.has(other.accountId)).toBe(false);
    });

    it('voids the code at the fifth failure for good, even for the right code', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await expect(acceptWith(useCases, invite.token, 'AAAAA-AAAAA')).resolves.toEqual({
          ok: false,
          error: { code: 'handover-code.invalid' },
        });
      }
      const afterwards = await useCases.start.execute(anonymous(), {
        token: invite.token,
        client: CLIENT,
      });

      expect(afterwards).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect(fakes.invitations.get(invite.invitationId)).toMatchObject({
        state: 'pending',
        handoverFailedAttempts: 5,
      });
      expect(fakes.accounts.has(invite.accountId)).toBe(false);
    });

    it('answers unknown, used and expired tokens alike', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);
      const accepted = await acceptWith(useCases, invite.token, invite.handoverCode);
      expect(accepted.ok).toBe(true);

      const used = await useCases.start.execute(anonymous(), {
        token: invite.token,
        client: CLIENT,
      });
      const unknown = await useCases.start.execute(anonymous(), {
        token: tokens.issue().token,
        client: CLIENT,
      });
      const second = await issued(useCases, 'second@example.com');
      clock.advance(Temporal.Duration.from({ minutes: lifetime }));
      const expired = await useCases.start.execute(anonymous(), {
        token: second.token,
        client: CLIENT,
      });

      expect(used).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
      expect(unknown).toEqual(used);
      expect(expired).toEqual(used);
    });

    it('never accepts an invitation of another kind through the agent route', async () => {
      const useCases = setUp();
      const adminInvitation = Invitation.issue({
        id: id<'Invitation'>('01990000-0000-7000-8000-0000000000ab'),
        marketId,
        kind: 'admin',
        email: email('someone@example.com'),
        roleId: ROLE,
        sellerId: null,
        invitedByAccountId: ADMIN,
        now: START,
      });
      const minted = tokens.issue();
      adminInvitation.dispatch(minted.tokenHash, START, lifetime);
      fakes.invitations.set(adminInvitation.state.id, adminInvitation.state);

      const result = await useCases.start.execute(anonymous(), {
        token: minted.token,
        client: CLIENT,
      });

      expect(result).toEqual({ ok: false, error: { code: 'invitation.rejected' } });
    });

    it('counts failed attempts on the per-origin sign-in limit across many invitations', async () => {
      const useCases = setUp();
      const limit = policy.signInThrottles(market).origin.limit;
      let throttled = false;
      for (let n = 0; n <= limit + 1 && !throttled; n += 1) {
        const invite = await issued(useCases, `many${n}@example.com`);
        const result = await acceptWith(useCases, invite.token, 'AAAAA-AAAAA').catch(() => null);
        throttled = result?.ok === false && result.error.code === 'request.throttled';
        if (result === null) throttled = true;
      }

      expect(throttled).toBe(true);
    });

    it('rejects a malformed code without counting anything', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      const refused = await acceptWith(useCases, invite.token, 'not a code');

      expect(refused).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(fakes.invitations.get(invite.invitationId)).toMatchObject({
        handoverFailedAttempts: 0,
      });
    });

    it('enforces the password rules against the address and the name', async () => {
      const useCases = setUp();
      const invite = await issued(useCases);

      const refused = await acceptWith(useCases, invite.token, invite.handoverCode, {
        password: 'short',
      });

      expect(refused.ok).toBe(false);
      expect(fakes.accounts.has(invite.accountId)).toBe(false);
      expect(fakes.invitations.get(invite.invitationId)!.state).toBe('pending');
    });
  });
});

function fromBase32(text: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}
