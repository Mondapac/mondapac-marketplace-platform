import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { parseEmailAddress } from './email-address';
import { HANDOVER_MAX_FAILED_ATTEMPTS } from './handover-code';
import { Invitation, InvitationInvariantError } from './invitation';

const NOW = Temporal.Instant.from('2026-11-06T10:00:00Z');
const TOKEN_HASH = new Uint8Array(32).fill(7);
const CODE_HMAC = new Uint8Array(32).fill(3);

function id<T extends string>(text: string): Id<T> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}
const email = (raw: string) => {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('bad email');
  return parsed.value;
};

const INVITATION_ID = id<'Invitation'>('01990000-0000-7000-8000-0000000000c1');
const AGENT_ACCOUNT_ID = id<'Account'>('01990000-0000-7000-8000-0000000000a1');
const ACCEPTED_ID = AGENT_ACCOUNT_ID;
const ADMIN_ID = id<'Account'>('01990000-0000-7000-8000-000000000001');

// The agent invitation in both fixture Markets: lifetimes differ (AU 72 hours, ZZ 48).
describe.each([
  ['AU', 4320],
  ['ZZ', 2880],
] as const)('agent Invitation in market %s (ADR-0045 decision 2)', (code, lifetimeMinutes) => {
  const marketId = market(code);
  const issued = () =>
    Invitation.issueAgent({
      id: INVITATION_ID,
      marketId,
      email: email('Agent.One@Example.test'),
      displayName: 'Agent One',
      agentAccountId: AGENT_ACCOUNT_ID,
      handoverCodeHmac: CODE_HMAC,
      invitedByAccountId: ADMIN_ID,
      now: NOW,
    });
  const dispatched = () => {
    const invitation = Invitation.restore(issued().state);
    expect(invitation.dispatch(TOKEN_HASH, NOW, lifetimeMinutes).ok).toBe(true);
    return Invitation.restore(invitation.state);
  };

  it('is issued pending with no role or seller, the reserved account id and a live code', () => {
    const invitation = issued();

    expect(invitation.state).toMatchObject({
      kind: 'agent',
      state: 'pending',
      roleId: null,
      sellerId: null,
      agentAccountId: AGENT_ACCOUNT_ID,
      invitedByAccountId: ADMIN_ID,
      displayName: 'Agent One',
      handoverFailedAttempts: 0,
      version: 1,
    });
    expect(invitation.state.handoverCodeHmac).toEqual(CODE_HMAC);
    expect(invitation.handoverCodeLive).toBe(true);
    expect(invitation.pendingEvents.map((event) => event.type)).toEqual([
      'identity.invitation-issued.v1',
    ]);
    expect(invitation.pendingEvents[0]!.payload).toEqual({
      invitationId: INVITATION_ID,
      kind: 'agent',
      sellerId: null,
    });
  });

  it('refuses an agent invitation with no handover code or no inviter', () => {
    const base = issued().state;
    expect(() => Invitation.restore({ ...base, handoverCodeHmac: null })).toThrow(
      InvitationInvariantError,
    );
    expect(() => Invitation.restore({ ...base, agentAccountId: null })).toThrow(
      InvitationInvariantError,
    );
    expect(() => Invitation.restore({ ...base, handoverFailedAttempts: null })).toThrow(
      InvitationInvariantError,
    );
    expect(() => Invitation.restore({ ...base, invitedByAccountId: null })).toThrow(
      InvitationInvariantError,
    );
    expect(() =>
      Invitation.restore({ ...base, roleId: ADMIN_ID as unknown as Id<'Role'> }),
    ).toThrow(InvitationInvariantError);
  });

  it('is not usable before dispatch, and usable after it until the lifetime ends', () => {
    expect(issued().usableAt(NOW)).toBe(false);
    const invitation = dispatched();

    expect(invitation.usableAt(NOW.add({ minutes: lifetimeMinutes - 1 }))).toBe(true);
    expect(invitation.usableAt(NOW.add({ minutes: lifetimeMinutes }))).toBe(false);
  });

  it('accepts only with the matching code, in one step, and clears the personal data and the code', () => {
    const invitation = dispatched();

    expect(invitation.acceptAgent(ACCEPTED_ID, false, NOW).ok).toBe(false);
    expect(invitation.state.state).toBe('pending');
    expect(invitation.acceptAgent(ACCEPTED_ID, true, NOW).ok).toBe(true);
    expect(invitation.state).toMatchObject({
      state: 'accepted',
      acceptedAccountId: ACCEPTED_ID,
      email: null,
      displayName: null,
      handoverCodeHmac: null,
      agentAccountId: AGENT_ACCOUNT_ID,
    });
    expect(invitation.pendingEvents.map((event) => event.type)).toContain(
      'identity.invitation-accepted.v1',
    );
    // Once only.
    expect(invitation.acceptAgent(ACCEPTED_ID, true, NOW).ok).toBe(false);
  });

  it('refuses the generic accept for an agent invitation: the code check is not skippable', () => {
    expect(dispatched().accept(ACCEPTED_ID, NOW).ok).toBe(false);
  });

  it('refuses acceptance of an undispatched, expired or revoked invitation even with the code', () => {
    expect(issued().acceptAgent(ACCEPTED_ID, true, NOW).ok).toBe(false);
    expect(
      dispatched().acceptAgent(ACCEPTED_ID, true, NOW.add({ minutes: lifetimeMinutes })).ok,
    ).toBe(false);
    const revoked = dispatched();
    revoked.revoke(NOW);
    expect(revoked.acceptAgent(ACCEPTED_ID, true, NOW).ok).toBe(false);
  });

  it('counts a wrong code, and voids the code from the fifth failure for good', () => {
    const invitation = dispatched();

    for (let attempt = 1; attempt <= HANDOVER_MAX_FAILED_ATTEMPTS; attempt += 1) {
      expect(invitation.handoverCodeLive).toBe(true);
      expect(invitation.presentHandoverCode(false, NOW).ok).toBe(false);
      expect(invitation.state.handoverFailedAttempts).toBe(attempt);
    }
    expect(invitation.handoverCodeLive).toBe(false);
    // The right code no longer works, neither to present nor to accept; the count stops at 5.
    expect(invitation.presentHandoverCode(true, NOW).ok).toBe(false);
    expect(invitation.acceptAgent(ACCEPTED_ID, true, NOW).ok).toBe(false);
    expect(invitation.presentHandoverCode(false, NOW).ok).toBe(false);
    expect(invitation.state.handoverFailedAttempts).toBe(HANDOVER_MAX_FAILED_ATTEMPTS);
    expect(invitation.state.state).toBe('pending');
  });

  it('keeps a correct presentation unchanged and does not advance the version', () => {
    const invitation = dispatched();
    const version = invitation.state.version;

    expect(invitation.presentHandoverCode(true, NOW).ok).toBe(true);
    expect(invitation.state.version).toBe(version);
    expect(invitation.state.handoverFailedAttempts).toBe(0);
  });

  it('does not count an attempt against an invitation that is not usable', () => {
    const invitation = dispatched();
    const later = NOW.add({ minutes: lifetimeMinutes });

    expect(invitation.presentHandoverCode(false, later).ok).toBe(false);
    expect(invitation.state.handoverFailedAttempts).toBe(0);
  });

  it('revokes pending, clearing the code, and is replaceable once stale', () => {
    const invitation = dispatched();
    expect(invitation.replaceableAt(NOW, lifetimeMinutes)).toBe(false);
    expect(invitation.replaceableAt(NOW.add({ minutes: lifetimeMinutes }), lifetimeMinutes)).toBe(
      true,
    );

    expect(invitation.revoke(NOW).ok).toBe(true);
    expect(invitation.state).toMatchObject({
      state: 'revoked',
      handoverCodeHmac: null,
      email: null,
      displayName: null,
    });
  });

  it('is never re-sent in place: a lost code means revoke and issue again', () => {
    expect(dispatched().reissue(NOW, lifetimeMinutes).ok).toBe(false);
  });
});
