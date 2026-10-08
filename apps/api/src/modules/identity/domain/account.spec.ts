import { parseId, parseMarketId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId } from '@mondapac/shared-kernel';
import { Account, AccountInvariantError, type AccountState } from './account';

const NOW = Temporal.Instant.from('2026-10-07T10:00:00Z');
const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHRzYWx0c2FsdA$dGFndGFndGFn';
const NEW_HASH = '$argon2id$v=19$m=65536,t=3,p=1$bmV3c2FsdG5ld3NhbHQ$bmV3dGFnbmV3dGFn';
const EMAIL = { typed: 'Customer@Example.com', normalized: 'customer@example.com' };

function id(text: string): Id<'Account'> {
  const parsed = parseId(text);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<'Account'>;
}
function market(code: string): MarketId {
  const parsed = parseMarketId(code);
  if (!parsed.ok) throw new Error('bad market');
  return parsed.value;
}

const ACCOUNT_ID = id('01990000-0000-7000-8000-000000000001');

describe.each(['AU', 'ZZ'])('Account in market %s (identity design 2.1, 3.1, 3.2, 6.7)', (code) => {
  const marketId = market(code);
  const register = () =>
    Account.registerCustomer({
      id: ACCOUNT_ID,
      marketId,
      email: EMAIL,
      passwordHash: HASH,
      now: NOW,
    });

  describe('registerCustomer', () => {
    it('creates an active, unverified customer account with no display name, version 1', () => {
      const account = register();

      expect(account.state).toEqual<AccountState>({
        id: ACCOUNT_ID,
        marketId,
        population: 'customer',
        email: EMAIL,
        displayName: null,
        status: 'active',
        emailVerifiedAt: null,
        existingAccountNoticeAt: null,
        signedUpAt: NOW,
        createdAt: NOW,
        version: 1,
        credential: { passwordHash: HASH, changedAt: NOW },
      });
      expect(account.persistedVersion).toBeNull();
    });

    it('records customer-account-registered with the account id only', () => {
      const [event, ...rest] = register().pendingEvents;

      expect(rest).toEqual([]);
      expect(event).toMatchObject({
        type: 'identity.customer-account-registered.v1',
        aggregateType: 'account',
        aggregateId: ACCOUNT_ID,
        aggregateVersion: 1,
        occurredAt: NOW,
        payload: { accountId: ACCOUNT_ID },
      });
    });

    it('takes no display name: the factory has no such input', () => {
      const input = { id: ACCOUNT_ID, marketId, email: EMAIL, passwordHash: HASH, now: NOW };
      const withName = { ...input, displayName: 'Injected Name' };

      expect(Account.registerCustomer(withName).state.displayName).toBeNull();
    });
  });

  describe('signUpAgain', () => {
    const LATER = NOW.add({ hours: 2 });

    it('on an unverified account, replaces the password and restarts the purge anchor', () => {
      const account = Account.restore(register().state);

      const outcome = account.signUpAgain({ passwordHash: NEW_HASH, now: LATER, noticeHours: 24 });

      expect(outcome).toBe('unverified-replaced');
      expect(account.state).toMatchObject({
        signedUpAt: LATER,
        createdAt: NOW,
        version: 2,
        displayName: null,
        emailVerifiedAt: null,
        credential: { passwordHash: NEW_HASH, changedAt: LATER },
      });
      expect(account.persistedVersion).toBe(1);
      expect(account.pendingEvents).toEqual([
        expect.objectContaining({
          type: 'identity.sign-up-repeated.v1',
          aggregateVersion: 2,
          occurredAt: LATER,
          payload: { accountId: ACCOUNT_ID, cause: 'unverified-replaced' },
        }),
      ]);
    });

    describe('on a verified account', () => {
      const verified = (noticeAt: Temporal.Instant | null) =>
        Account.restore({
          ...register().state,
          emailVerifiedAt: NOW.add({ minutes: 5 }),
          existingAccountNoticeAt: noticeAt,
        });

      it('never touches the password or the purge anchor, and records a notice', () => {
        const account = verified(null);

        expect(account.signUpAgain({ passwordHash: NEW_HASH, now: LATER, noticeHours: 24 })).toBe(
          'verified-notice',
        );
        expect(account.state).toMatchObject({
          credential: { passwordHash: HASH, changedAt: NOW },
          signedUpAt: NOW,
          existingAccountNoticeAt: LATER,
          version: 2,
        });
        expect(account.pendingEvents).toEqual([
          expect.objectContaining({
            payload: { accountId: ACCOUNT_ID, cause: 'verified-notice' },
          }),
        ]);
      });

      it('sends at most one notice per interval of the Market', () => {
        const account = verified(LATER.subtract({ hours: 23, minutes: 59 }));

        expect(account.signUpAgain({ passwordHash: NEW_HASH, now: LATER, noticeHours: 24 })).toBe(
          'unchanged',
        );
        expect(account.state.version).toBe(1);
        expect(account.pendingEvents).toEqual([]);
      });

      it('sends the next notice once the interval has passed', () => {
        const account = verified(LATER.subtract({ hours: 12 }));

        expect(account.signUpAgain({ passwordHash: NEW_HASH, now: LATER, noticeHours: 12 })).toBe(
          'verified-notice',
        );
      });
    });
  });

  describe('restore', () => {
    it.each(['seller', 'admin'] as const)(
      'refuses a %s account without a display name',
      (population) => {
        expect(() => Account.restore({ ...register().state, population })).toThrow(
          AccountInvariantError,
        );
      },
    );

    it('accepts a seller account with a display name', () => {
      expect(
        Account.restore({ ...register().state, population: 'seller', displayName: 'Shop' }).state
          .population,
      ).toBe('seller');
    });

    it('starts with no pending event and remembers the stored version', () => {
      const account = Account.restore({ ...register().state, version: 7 });

      expect(account.pendingEvents).toEqual([]);
      expect(account.persistedVersion).toBe(7);
    });
  });
  describe('rehashPassword and credentialChanged (identity design 6.5; Mojtaba N-b)', () => {
    const stored = () => Account.restore({ ...register().state, version: 3 });

    it('replaces the hash, keeps changedAt, raises the version and records no event', () => {
      const account = stored();

      account.rehashPassword(NEW_HASH);

      expect(account.state.credential).toEqual({ passwordHash: NEW_HASH, changedAt: NOW });
      expect(account.state.version).toBe(4);
      expect(account.pendingEvents).toEqual([]);
      expect(account.credentialChanged).toBe(true);
    });

    it('does nothing for the same hash', () => {
      const account = stored();

      account.rehashPassword(HASH);

      expect(account.state.version).toBe(3);
      expect(account.credentialChanged).toBe(false);
    });

    it('reports no credential change when only the notice instant changed', () => {
      const account = Account.restore({
        ...register().state,
        emailVerifiedAt: NOW,
        version: 3,
      });

      account.signUpAgain({ passwordHash: NEW_HASH, now: NOW.add({ hours: 30 }), noticeHours: 24 });

      expect(account.state.version).toBe(4);
      expect(account.credentialChanged).toBe(false);
    });

    it('reports a credential change when an unverified sign-up replaced the password', () => {
      const account = stored();

      account.signUpAgain({ passwordHash: NEW_HASH, now: NOW.add({ hours: 1 }), noticeHours: 24 });

      expect(account.credentialChanged).toBe(true);
    });

    it('knows whether the email is verified', () => {
      expect(stored().isEmailVerified).toBe(false);
      expect(Account.restore({ ...register().state, emailVerifiedAt: NOW }).isEmailVerified).toBe(
        true,
      );
    });
  });
});
