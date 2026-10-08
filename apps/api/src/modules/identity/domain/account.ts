import { Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketId, PendingEvent, Population } from '@mondapac/shared-kernel';
import type { EmailAddress } from './email-address';
import { AccountEmailVerified, CustomerAccountRegistered, SignUpRepeated } from './events';

/** The password credential, an entity of the account: a PHC string and when it was set. */
export interface PasswordCredential {
  readonly passwordHash: string;
  readonly changedAt: Temporal.Instant;
}

/** The state of an {@link Account} (identity design 2.1; data design 3.3). */
export interface AccountState {
  readonly id: Id<'Account'>;
  readonly marketId: MarketId;
  readonly population: Population;
  readonly email: EmailAddress;
  /** Null only for a customer (2.1; data design N1). */
  readonly displayName: string | null;
  readonly status: 'active' | 'disabled';
  readonly emailVerifiedAt: Temporal.Instant | null;
  readonly existingAccountNoticeAt: Temporal.Instant | null;
  /** The latest sign-up: the anchor of the 7-day purge (M5). */
  readonly signedUpAt: Temporal.Instant;
  readonly createdAt: Temporal.Instant;
  readonly version: number;
  readonly credential: PasswordCredential;
}

/** What a repeated sign-up did (identity design 3.2, 6.7). */
export type SignUpAgainOutcome = 'unverified-replaced' | 'verified-notice' | 'unchanged';

/** A state that breaks an invariant of 2.1: a bug of the caller or a corrupt row. */
export class AccountInvariantError extends Error {
  override readonly name = 'AccountInvariantError';
  constructor(readonly invariant: 'display-name-required') {
    super(`Account invariant broken: ${invariant}`);
  }
}

/**
 * The `Account` aggregate (identity design 2.1). One population for life, one Market; the
 * email is unique per Market and population (the database constraint). A seller-side or admin
 * account always has a display name; a customer account may have none, and the customer
 * factory takes none. Times come from the caller's `Clock`; every change raises the version
 * by one and records at most one event (platform persistence 5.1): every state change of
 * 3.1 and 3.2 records one, the re-hash of 6.5 none.
 */
export class Account {
  #state: AccountState;
  #events: PendingEvent[] = [];
  /** The credential as read from the store (null for a new account), for {@link credentialChanged}. */
  readonly #storedCredential: PasswordCredential | null;

  private constructor(
    state: AccountState,
    /** The version read from the store; null for an account not stored yet. */
    readonly persistedVersion: number | null,
  ) {
    if (state.population !== 'customer' && state.displayName === null) {
      throw new AccountInvariantError('display-name-required');
    }
    this.#state = Object.freeze({ ...state });
    this.#storedCredential = persistedVersion === null ? null : this.#state.credential;
  }

  /**
   * Customer sign-up (identity design 3.1, 3.2): an active, unverified customer account with
   * no display name (brief flow «د» item 1; `ux.md` A2). Any other input is ignored.
   */
  static registerCustomer(input: {
    readonly id: Id<'Account'>;
    readonly marketId: MarketId;
    readonly email: EmailAddress;
    readonly passwordHash: string;
    readonly now: Temporal.Instant;
  }): Account {
    const { id, marketId, email, passwordHash, now } = input;
    const account = new Account(
      {
        id,
        marketId,
        population: 'customer',
        email: Object.freeze({ typed: email.typed, normalized: email.normalized }),
        displayName: null,
        status: 'active',
        emailVerifiedAt: null,
        existingAccountNoticeAt: null,
        signedUpAt: now,
        createdAt: now,
        version: 1,
        credential: Object.freeze({ passwordHash, changedAt: now }),
      },
      null,
    );
    account.#events.push(
      CustomerAccountRegistered.record({
        aggregateId: id,
        aggregateVersion: 1,
        occurredAt: now,
        payload: { accountId: id },
      }),
    );
    return account;
  }

  /**
   * Seller sign-up (identity design 3.1; slice 5): an active, unverified seller account with
   * the display name the caller parsed (`parseDisplayName`, HF13). No event: 8.2 has none for a
   * seller account; the seller is published by its `SellerAccess` at the email verification.
   */
  static registerSeller(input: {
    readonly id: Id<'Account'>;
    readonly marketId: MarketId;
    readonly email: EmailAddress;
    readonly displayName: string;
    readonly passwordHash: string;
    readonly now: Temporal.Instant;
  }): Account {
    const { id, marketId, email, displayName, passwordHash, now } = input;
    if (displayName.trim() === '') throw new AccountInvariantError('display-name-required');
    return new Account(
      {
        id,
        marketId,
        population: 'seller',
        email: Object.freeze({ typed: email.typed, normalized: email.normalized }),
        displayName,
        status: 'active',
        emailVerifiedAt: null,
        existingAccountNoticeAt: null,
        signedUpAt: now,
        createdAt: now,
        version: 1,
        credential: Object.freeze({ passwordHash, changedAt: now }),
      },
      null,
    );
  }

  /** An account read from the store. Checks the invariants again. */
  static restore(state: AccountState): Account {
    return new Account(state, state.version);
  }

  get state(): AccountState {
    return this.#state;
  }

  /** Whether the owner confirmed the email (identity design 3.2). */
  get isEmailVerified(): boolean {
    return this.#state.emailVerifiedAt !== null;
  }

  /**
   * Whether the credential differs from the one read from the store, so the repository writes
   * `password_credentials` only then (Mojtaba N-b). Always true for a new account.
   */
  get credentialChanged(): boolean {
    return this.#storedCredential !== this.#state.credential;
  }

  /** Events recorded since the account was built or restored. */
  get pendingEvents(): readonly PendingEvent[] {
    return [...this.#events];
  }

  /**
   * A sign-up with the address of this account (identity design 3.2 and 6.7):
   *
   * - unverified: the password is replaced and the purge anchor restarts, so the real owner of
   *   the address can always take it back from a squatter; the older link becomes void when
   *   links exist (slice 3);
   * - verified: nothing of the account changes; the holder is told "you already have an
   *   account", at most once per `noticeHours` (the Market's policy, 24 hours), and only when
   *   `mailAllowed`: the request's verdict on the mail counters (identity design 6.8; Mojtaba
   *   item 3). A notice the counters refused is not recorded, so the next sign-up may send it.
   *
   * The caller hashed the new password before reading the account (HF12), whichever branch
   * follows. On an unverified seller-side account the display name given now replaces the old
   * one too (6.7); a customer account never takes one. The verification link is the caller's:
   * it requests it again in the same unit (3.7).
   */
  signUpAgain(input: {
    readonly passwordHash: string;
    /** The parsed name of a seller sign-up; ignored for a customer account. */
    readonly displayName?: string;
    readonly now: Temporal.Instant;
    readonly noticeHours: number;
    readonly mailAllowed: boolean;
  }): SignUpAgainOutcome {
    const { passwordHash, now, noticeHours, mailAllowed } = input;
    const state = this.#state;
    if (state.emailVerifiedAt === null) {
      const name =
        state.population !== 'customer' &&
        input.displayName !== undefined &&
        input.displayName.trim() !== ''
          ? { displayName: input.displayName }
          : {};
      this.change(
        {
          ...name,
          signedUpAt: now,
          credential: Object.freeze({ passwordHash, changedAt: now }),
        },
        now,
        'unverified-replaced',
      );
      return 'unverified-replaced';
    }
    const last = state.existingAccountNoticeAt;
    if (
      !mailAllowed ||
      (last !== null && Temporal.Instant.compare(now, last.add({ hours: noticeHours })) < 0)
    ) {
      return 'unchanged';
    }
    this.change({ existingAccountNoticeAt: now }, now, 'verified-notice');
    return 'verified-notice';
  }

  /**
   * The email is confirmed (identity design 3.2): by the link and the account's password, in
   * the closing unit of the confirmation (6.3). Records `identity.account-email-verified.v1`.
   * An account already verified does not change; the answer says whether this call verified it.
   */
  verifyEmail(now: Temporal.Instant): boolean {
    if (this.#state.emailVerifiedAt !== null) return false;
    const version = this.#state.version + 1;
    this.#state = Object.freeze({ ...this.#state, emailVerifiedAt: now, version });
    this.#events.push(
      AccountEmailVerified.record({
        aggregateId: this.#state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: this.#state.id, population: this.#state.population },
      }),
    );
    return true;
  }

  /**
   * Replaces a hash made with older parameters after a successful sign-in (identity design 6.5).
   * The password is the same, so `changedAt` stays and no event is recorded; the version rises
   * by one, so a concurrent change of the account wins or loses as a whole (platform persistence
   * 5.1: at most one event per version step).
   */
  rehashPassword(passwordHash: string): void {
    const credential = this.#state.credential;
    if (passwordHash === credential.passwordHash) return;
    this.#state = Object.freeze({
      ...this.#state,
      credential: Object.freeze({ passwordHash, changedAt: credential.changedAt }),
      version: this.#state.version + 1,
    });
  }

  private change(
    fields: Partial<AccountState>,
    now: Temporal.Instant,
    cause: 'unverified-replaced' | 'verified-notice',
  ): void {
    const version = this.#state.version + 1;
    this.#state = Object.freeze({ ...this.#state, ...fields, version });
    this.#events.push(
      SignUpRepeated.record({
        aggregateId: this.#state.id,
        aggregateVersion: version,
        occurredAt: now,
        payload: { accountId: this.#state.id, cause },
      }),
    );
  }
}
