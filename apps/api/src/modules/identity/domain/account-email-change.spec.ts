import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Account, type AccountState } from './account';
import { maskEmailAddress, parseEmailAddress, type EmailAddress } from './email-address';

const NOW = Temporal.Instant.from('2026-11-16T10:00:00Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';
const OLD = { typed: 'Maryam.Old@Example.com', normalized: 'maryam.old@example.com' };

function email(raw: string): EmailAddress {
  const parsed = parseEmailAddress(raw);
  if (!parsed.ok) throw new Error('test setup: bad address');
  return parsed.value;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('test setup: bad market');
  return parsed.value;
}
const ACCOUNT_ID = (() => {
  const parsed = parseId('01990000-0000-7000-8000-00000000e001');
  if (!parsed.ok) throw new Error('test setup: bad id');
  return parsed.value as Id<'Account'>;
})();

const NEW = email('Maryam.New@Mailbox.test');

// Both market fixtures (ADR-0003 decision 9): nothing here depends on the Market.
describe.each(['AU', 'ZZ'])(
  'Account email change in market %s (customers admin email change)',
  (code) => {
    const marketId = market(code);
    const state = (overrides: Partial<AccountState> = {}): AccountState => ({
      id: ACCOUNT_ID,
      marketId,
      population: 'customer',
      email: OLD,
      displayName: null,
      status: 'active',
      emailVerifiedAt: NOW.subtract({ hours: 48 }),
      existingAccountNoticeAt: null,
      signedUpAt: NOW.subtract({ hours: 48 }),
      createdAt: NOW.subtract({ hours: 48 }),
      version: 3,
      credential: { passwordHash: HASH, changedAt: NOW.subtract({ hours: 48 }) },
      ...overrides,
    });
    const account = (overrides: Partial<AccountState> = {}) => Account.restore(state(overrides));

    describe('requestEmailChange', () => {
      it('keeps the current address, stores the pending one in one version step and records the event', () => {
        const a = account();
        expect(a.requestEmailChange({ email: NEW, now: NOW })).toEqual({ ok: true, value: true });
        expect(a.state.email).toEqual(OLD);
        expect(a.state.pendingEmail).toEqual(NEW);
        expect(a.state.pendingEmailRequestedAt).toEqual(NOW);
        expect(a.state.version).toBe(4);
        expect(a.pendingEvents).toEqual([
          expect.objectContaining({
            type: 'identity.account-email-change-requested.v1',
            aggregateId: ACCOUNT_ID,
            aggregateVersion: 4,
            occurredAt: NOW,
            // Ids and population only: never an address (R9).
            payload: { accountId: ACCOUNT_ID, population: 'customer' },
          }),
        ]);
      });

      it('answers false for the current address in any case and changes nothing', () => {
        const a = account();
        expect(a.requestEmailChange({ email: email(' maryam.OLD@example.COM'), now: NOW })).toEqual(
          {
            ok: true,
            value: false,
          },
        );
        expect(a.state).toEqual(state());
        expect(a.pendingEvents).toEqual([]);
      });

      it.each<[string, Partial<AccountState>]>([
        ['a seller account', { population: 'seller', displayName: 'Shop' }],
        ['an admin account', { population: 'admin', displayName: 'Admin' }],
        ['a disabled account', { status: 'disabled' }],
        ['an unverified account', { emailVerifiedAt: null }],
      ])('refuses %s as not eligible', (_name, overrides) => {
        const a = account(overrides);
        expect(a.requestEmailChange({ email: NEW, now: NOW })).toEqual({
          ok: false,
          error: { code: 'account.not-eligible' },
        });
        expect(a.pendingEvents).toEqual([]);
      });

      it('lets a newer request replace an older one', () => {
        const a = account();
        a.requestEmailChange({ email: NEW, now: NOW });
        const later = NOW.add({ minutes: 5 });
        a.requestEmailChange({ email: email('third@mailbox.test'), now: later });
        expect(a.state.pendingEmail?.normalized).toBe('third@mailbox.test');
        expect(a.state.pendingEmailRequestedAt).toEqual(later);
      });
    });

    describe('pendingEmailChange', () => {
      it('shows the pending change until it lapses at the request plus the link lifetime', () => {
        const a = account({ pendingEmail: NEW, pendingEmailRequestedAt: NOW });
        expect(a.pendingEmailChange(NOW.add({ minutes: 59 }), 60)).toEqual({
          email: NEW,
          requestedAt: NOW,
        });
        expect(a.pendingEmailChange(NOW.add({ minutes: 60 }), 60)).toBeNull();
        expect(account().pendingEmailChange(NOW, 60)).toBeNull();
      });
    });

    describe('cancelEmailChange', () => {
      it('clears the pending address in one version step, without an event', () => {
        const a = account({ pendingEmail: NEW, pendingEmailRequestedAt: NOW });
        expect(a.cancelEmailChange()).toBe(true);
        expect(a.state.pendingEmail).toBeNull();
        expect(a.state.pendingEmailRequestedAt).toBeNull();
        expect(a.state.version).toBe(4);
        expect(a.pendingEvents).toEqual([]);
      });

      it('answers false when nothing is pending', () => {
        const a = account();
        expect(a.cancelEmailChange()).toBe(false);
        expect(a.state.version).toBe(3);
      });
    });

    describe('confirmEmailChange', () => {
      const LATER = NOW.add({ minutes: 30 });

      it('swaps the address, verifies it now, clears pending and answers the previous one', () => {
        const a = account({ pendingEmail: NEW, pendingEmailRequestedAt: NOW });
        expect(a.confirmEmailChange({ requestedAt: NOW, now: LATER, lifetimeMinutes: 60 })).toEqual(
          {
            ok: true,
            value: OLD,
          },
        );
        expect(a.state.email).toEqual(NEW);
        expect(a.state.emailVerifiedAt).toEqual(LATER);
        expect(a.state.pendingEmail).toBeNull();
        expect(a.state.pendingEmailRequestedAt).toBeNull();
        expect(a.state.version).toBe(4);
        // One event, and no account-email-verified (Mohammad 4).
        expect(a.pendingEvents).toEqual([
          expect.objectContaining({
            type: 'identity.account-email-changed.v1',
            aggregateVersion: 4,
            occurredAt: LATER,
            payload: { accountId: ACCOUNT_ID, population: 'customer' },
          }),
        ]);
      });

      it('binds to the request at millisecond precision (the store keeps no more)', () => {
        const precise = NOW.add({ microseconds: 250 });
        const a = account({ pendingEmail: NEW, pendingEmailRequestedAt: precise });
        expect(a.confirmEmailChange({ requestedAt: NOW, now: LATER, lifetimeMinutes: 60 }).ok).toBe(
          true,
        );
      });

      it('lapses at the request plus the lifetime, the same boundary as the read (Sajad 5)', () => {
        const before = account({ pendingEmail: NEW, pendingEmailRequestedAt: NOW });
        const confirmedJustBefore = before.confirmEmailChange({
          requestedAt: NOW,
          now: NOW.add({ minutes: 60 }).subtract({ milliseconds: 1 }),
          lifetimeMinutes: 60,
        });
        expect(confirmedJustBefore.ok).toBe(true);
        const at = account({ pendingEmail: NEW, pendingEmailRequestedAt: NOW });
        expect(
          at.confirmEmailChange({
            requestedAt: NOW,
            now: NOW.add({ minutes: 60 }),
            lifetimeMinutes: 60,
          }),
        ).toEqual({ ok: false, error: { code: 'link.rejected' } });
        expect(at.state.pendingEmail).toEqual(NEW);
        expect(at.pendingEvents).toEqual([]);
      });

      it.each<[string, Partial<AccountState>, Temporal.Instant]>([
        ['nothing pending (cancelled or confirmed)', {}, NOW],
        [
          'a newer request than the link',
          { pendingEmail: NEW, pendingEmailRequestedAt: NOW.add({ minutes: 1 }) },
          NOW,
        ],
        [
          'a disabled account',
          { pendingEmail: NEW, pendingEmailRequestedAt: NOW, status: 'disabled' },
          NOW,
        ],
        [
          'a seller account',
          {
            pendingEmail: NEW,
            pendingEmailRequestedAt: NOW,
            population: 'seller',
            displayName: 'Shop',
          },
          NOW,
        ],
      ])('rejects the link for %s and changes nothing (R2)', (_name, overrides, requestedAt) => {
        const a = account(overrides);
        expect(a.confirmEmailChange({ requestedAt, now: LATER, lifetimeMinutes: 60 })).toEqual({
          ok: false,
          error: { code: 'link.rejected' },
        });
        expect(a.state).toEqual(state(overrides));
        expect(a.pendingEvents).toEqual([]);
      });
    });
  },
);

describe('maskEmailAddress (Hassan R9)', () => {
  it.each([
    ['maryam@example.com', 'm***@e***.com'],
    ['Maryam.New@Mailbox.TEST', 'm***@m***.test'],
    ['first.last+shop@sub.domain.co.nz', 'f***@s***.nz'],
    ['_x@-y.de', '****@****.de'],
    ['élie@éxample.fr', '****@****.fr'],
  ])('masks %s as %s', (raw, expected) => {
    expect(maskEmailAddress(email(raw))).toBe(expected);
  });

  it('never shows more than one character of either part, nor markup', () => {
    const masked = maskEmailAddress(email('<script>@evil.example'));
    expect(masked).not.toMatch(/[<>"']/);
    expect(masked).toBe('****@e***.example');
  });
});
