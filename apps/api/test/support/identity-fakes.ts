import type { TestingModuleBuilder } from '@nestjs/testing';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  AuditEntry,
  CallContext,
  Id,
  MarketContext,
  PendingEvent,
  Population,
  Result,
} from '@mondapac/shared-kernel';
import {
  REVIEWER_CANDIDATE_READER,
  type ReviewerCandidateReader,
} from '../../src/modules/identity/application/ports/access-reviewers';
import {
  ACCOUNT_REPOSITORY,
  type AccountRepository,
} from '../../src/modules/identity/application/ports/account.repository';
import {
  PASSWORD_HASHER,
  type PasswordHasher,
  type PasswordHasherBusy,
  type PasswordVerification,
} from '../../src/modules/identity/application/ports/password-hasher';
import type { RoleGrant } from '../../src/modules/identity/application/access/effective-keys';
import {
  ROLE_GRANT_READER,
  type RoleGrantReader,
} from '../../src/modules/identity/application/ports/role-grant-reader';
import {
  SESSION_REPOSITORY,
  type SessionForAuthentication,
  type SessionRepository,
} from '../../src/modules/identity/application/ports/session.repository';
import {
  SIGN_IN_RECORD_REPOSITORY,
  type SignInRecord,
  type SignInRecordRepository,
} from '../../src/modules/identity/application/ports/sign-in-record.repository';
import {
  THROTTLE_REPOSITORY,
  type ThrottleCounter,
  type ThrottleRepository,
} from '../../src/modules/identity/application/ports/throttle.repository';
import {
  ONE_TIME_LINK_REPOSITORY,
  type OneTimeLinkRepository,
} from '../../src/modules/identity/application/ports/one-time-link.repository';
import {
  SELLER_ACCESS_REPOSITORY,
  type SellerAccessRepository,
} from '../../src/modules/identity/application/ports/seller-access.repository';
import {
  ROLE_ASSIGNMENT_REPOSITORY,
  ROLE_REPOSITORY,
  SELLER_MEMBERSHIP_REPOSITORY,
  type RoleAssignmentRepository,
  type RoleRepository,
  type SellerMembershipRepository,
} from '../../src/modules/identity/application/ports/seller-team.repository';
import { Account, type AccountState } from '../../src/modules/identity/domain/account';
import {
  Role,
  RoleAssignment,
  type RoleAssignmentState,
  type RoleState,
} from '../../src/modules/identity/domain/role';
import {
  SellerAccess,
  type SellerAccessState,
} from '../../src/modules/identity/domain/seller-access';
import {
  SellerMembership,
  type SellerMembershipState,
} from '../../src/modules/identity/domain/seller-membership';
import {
  OneTimeLink,
  type OneTimeLinkState,
} from '../../src/modules/identity/domain/one-time-link';
import type { Session } from '../../src/modules/identity/domain/session';
import {
  windowRestartBefore,
  type ThrottleReservation,
} from '../../src/modules/identity/domain/throttle';
import { AUDIT_WRITER, type AuditWriter } from '../../src/platform/audit/audit-writer';
import { OUTBOX_WRITER, type OutboxWriter } from '../../src/platform/events/outbox-writer';
import {
  MAIL_TRANSPORT,
  type MailMessage,
  type MailTransport,
} from '../../src/platform/mail/mail-transport';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import { UNIT_OF_WORK, type UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import { fakeRunOnce } from './fake-run-once';

// In-memory fakes of identity's database ports, for the HTTP suites of `pnpm test` (no
// database). Units are not isolated: `run` calls `work` once. The fakes keep the rules the
// suites depend on (unique keys, the throttle windows of data design 3.5); the PostgreSQL
// behaviour itself is covered by test/db/.

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** A fake PHC string: `fake$<password>`; verify compares the password. */
export const fakeHashOf = (password: string): string => `$argon2id$v=19$fake$${password}`;

export class IdentityFakes {
  readonly accounts = new Map<string, AccountState>();
  readonly sessions = new Map<string, { session: Session; tokenHash: string }>();
  readonly throttles = new Map<string, ThrottleReservation & { accountKey: string | null }>();
  readonly records: (SignInRecord & { marketId: string })[] = [];
  readonly events: PendingEvent[] = [];
  /** Audit entries recorded through identity's writer, with the actor kind and Market. */
  readonly audits: (AuditEntry & { actor: string; marketId: string })[] = [];
  readonly links = new Map<string, OneTimeLinkState>();
  readonly sellerAccess = new Map<string, SellerAccessState>();
  readonly memberships = new Map<string, SellerMembershipState>();
  readonly roles = new Map<string, RoleState>();
  readonly assignments = new Map<string, RoleAssignmentState>();
  /** Subject keys created and destroyed, by subject id (accounts and sellers). */
  readonly subjectKeys = new Map<string, 'live' | 'destroyed'>();
  /** Every account whose credential lock was taken, in order (N1). */
  readonly credentialLocks: string[] = [];
  /** Mails the fake transport accepted, in order. */
  readonly mails: MailMessage[] = [];
  /** Makes the fake transport refuse every send. */
  mailDown = false;
  hashed = 0;
  verified = 0;
  busy = false;
  /** Makes every correct verification ask for a re-hash (older parameters). */
  needsRehash = false;
  /** Makes the reservation unit fail, as an unreachable counter table would. */
  throttlesDown = false;

  reset(): void {
    this.accounts.clear();
    this.sessions.clear();
    this.throttles.clear();
    this.records.length = 0;
    this.events.length = 0;
    this.audits.length = 0;
    this.links.clear();
    this.sellerAccess.clear();
    this.memberships.clear();
    this.roles.clear();
    this.assignments.clear();
    this.subjectKeys.clear();
    this.credentialLocks.length = 0;
    this.mails.length = 0;
    this.mailDown = false;
    this.inbox.clear();
    this.hashed = 0;
    this.verified = 0;
    this.busy = false;
    this.needsRehash = false;
    this.throttlesDown = false;
  }

  /** Stores an account directly, as a test fixture. */
  seedAccount(state: AccountState): void {
    this.accounts.set(state.id, state);
  }

  /** Stores a seller access directly, as a test fixture. */
  seedSellerAccess(state: SellerAccessState): void {
    this.sellerAccess.set(state.sellerId, state);
  }

  /** Stores a membership directly, as a test fixture. */
  seedMembership(state: SellerMembershipState): void {
    this.memberships.set(state.id, state);
  }

  /** Stores a role directly, as a test fixture. */
  seedRole(state: RoleState): void {
    this.roles.set(state.id, state);
  }

  /** Stores an assignment directly, as a test fixture (admin fixture accounts: tests only). */
  seedAssignment(state: RoleAssignmentState): void {
    this.assignments.set(state.id, state);
  }

  /** The inbox of identity's handlers: `(Market, eventId, subscriber)` keys. */
  readonly inbox = new Set<string>();

  readonly unitOfWork: UnitOfWork = {
    run: <T, E>(_market: MarketContext, work: () => Promise<Result<T, E>>) => work(),
    runOnce: fakeRunOnce(this.inbox),
  };

  readonly accountRepository: AccountRepository = {
    findByEmail: (market: MarketContext, population: Population, email: string) => {
      const state = [...this.accounts.values()].find(
        (a) =>
          a.marketId === market.marketId &&
          a.population === population &&
          a.email.normalized === email,
      );
      return Promise.resolve(state === undefined ? null : Account.restore(state));
    },
    findById: (market: MarketContext, id: Id<'Account'>) => {
      const state = this.accounts.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Account.restore(state),
      );
    },
    lockCredential: (market: MarketContext, id: Id<'Account'>) => {
      const state = this.accounts.get(id);
      this.credentialLocks.push(id);
      return Promise.resolve(state !== undefined && state.marketId === market.marketId);
    },
    add: (_market: MarketContext, account: Account) => {
      this.subjectKeys.set(account.state.id, 'live');
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve(ok(undefined));
    },
    save: (_market: MarketContext, account: Account) => {
      // As the repository: the stored version must be the one read (StaleAggregateError).
      if (account.state.version === account.persistedVersion) return Promise.resolve();
      const stored = this.accounts.get(account.state.id);
      if (stored === undefined || stored.version !== account.persistedVersion) {
        return Promise.reject(new StaleAggregateError('account', account.state.id));
      }
      this.accounts.set(account.state.id, account.state);
      return Promise.resolve();
    },
    unverifiedSignedUpBefore: (market, before, limit) =>
      Promise.resolve(
        [...this.accounts.values()]
          .filter(
            (a) =>
              a.marketId === market.marketId &&
              a.emailVerifiedAt === null &&
              Temporal.Instant.compare(a.signedUpAt, before) < 0,
          )
          .sort((a, b) => Temporal.Instant.compare(a.signedUpAt, b.signedUpAt))
          .slice(0, limit)
          .map((a) => a.id),
      ),
    remove: (_market: MarketContext, account: Account) => {
      const id = account.state.id;
      // As the RESTRICT foreign keys: the caller removed the membership and assignment first.
      if (
        [...this.memberships.values()].some((m) => m.accountId === id) ||
        [...this.assignments.values()].some((a) => a.accountId === id)
      ) {
        return Promise.reject(new Error('a membership or an assignment still refers to it'));
      }
      this.subjectKeys.set(id, 'destroyed');
      this.accounts.delete(id);
      for (const [sessionId, s] of this.sessions) {
        if (s.session.accountId === id) this.sessions.delete(sessionId);
      }
      for (const [id, link] of this.links) {
        if (link.accountId === account.state.id) this.links.delete(id);
      }
      return Promise.resolve();
    },
  };

  /** The SQL narrowing of the reviewer read (identity design 8.7), over the fake accounts. */
  readonly reviewerCandidateReader: ReviewerCandidateReader = {
    activeVerifiedAdmins: (market, limit) =>
      Promise.resolve(
        [...this.accounts.values()]
          .filter(
            (a) =>
              a.marketId === market.marketId &&
              a.population === 'admin' &&
              a.status === 'active' &&
              a.emailVerifiedAt !== null,
          )
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .slice(0, limit)
          .map((a) => ({ accountId: a.id, email: a.email.typed })),
      ),
  };

  readonly sellerAccessRepository: SellerAccessRepository = {
    findById: (market, sellerId) => {
      const state = this.sellerAccess.get(sellerId);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId
          ? null
          : SellerAccess.restore(state),
      );
    },
    findRegistered: (market, sellerIds) =>
      Promise.resolve(
        sellerIds.flatMap((id) => {
          const state = this.sellerAccess.get(id);
          return state === undefined ||
            state.marketId !== market.marketId ||
            state.registeredAt === null
            ? []
            : [SellerAccess.restore(state)];
        }),
      ),
    listRegistered: (market, after, limit) =>
      Promise.resolve(
        [...this.sellerAccess.values()]
          .filter(
            (a) =>
              a.marketId === market.marketId &&
              a.registeredAt !== null &&
              (after === null || a.sellerId > after),
          )
          .sort((a, b) => (a.sellerId < b.sellerId ? -1 : 1))
          .slice(0, limit)
          .map((a) => ({ sellerId: a.sellerId, origin: a.origin })),
      ),
    add: (_market, access) => {
      this.subjectKeys.set(access.state.sellerId, 'live');
      this.sellerAccess.set(access.state.sellerId, access.state);
      return Promise.resolve();
    },
    save: (_market, access) => {
      if (access.state.version === access.persistedVersion) return Promise.resolve();
      const stored = this.sellerAccess.get(access.state.sellerId);
      if (stored === undefined || stored.version !== access.persistedVersion) {
        return Promise.reject(new StaleAggregateError('seller-access', access.state.sellerId));
      }
      this.sellerAccess.set(access.state.sellerId, access.state);
      return Promise.resolve();
    },
    removeUnregistered: (_market, access) => {
      const stored = this.sellerAccess.get(access.state.sellerId);
      if (
        stored === undefined ||
        stored.version !== access.persistedVersion ||
        stored.registeredAt !== null
      ) {
        return Promise.reject(new StaleAggregateError('seller-access', access.state.sellerId));
      }
      this.subjectKeys.set(access.state.sellerId, 'destroyed');
      this.sellerAccess.delete(access.state.sellerId);
      return Promise.resolve();
    },
  };

  readonly membershipRepository: SellerMembershipRepository = {
    findActiveByAccount: (market, accountId) => {
      const state = [...this.memberships.values()].find(
        (m) => m.marketId === market.marketId && m.accountId === accountId && m.state === 'active',
      );
      return Promise.resolve(state === undefined ? null : SellerMembership.restore(state));
    },
    findAllByAccount: (market, accountId) =>
      Promise.resolve(
        [...this.memberships.values()]
          .filter((m) => m.marketId === market.marketId && m.accountId === accountId)
          .map((m) => SellerMembership.restore(m)),
      ),
    sellerHasMembers: (market, sellerId) =>
      Promise.resolve(
        [...this.memberships.values()].some(
          (m) => m.marketId === market.marketId && m.sellerId === sellerId,
        ),
      ),
    add: (_market, membership) => {
      const state = membership.state;
      const active = [...this.memberships.values()].some(
        (m) =>
          m.marketId === state.marketId && m.accountId === state.accountId && m.state === 'active',
      );
      if (active && state.state === 'active') {
        return Promise.reject(new Error('seller_memberships_market_id_account_id_active_key'));
      }
      this.memberships.set(state.id, state);
      return Promise.resolve();
    },
    remove: (_market, membership) => {
      const stored = this.memberships.get(membership.state.id);
      if (stored === undefined || stored.version !== membership.persistedVersion) {
        return Promise.reject(new StaleAggregateError('seller-membership', membership.state.id));
      }
      this.memberships.delete(membership.state.id);
      return Promise.resolve();
    },
  };

  readonly roleRepository: RoleRepository = {
    findSystemRole: (market, scope) => {
      const state = [...this.roles.values()].find(
        (r) => r.marketId === market.marketId && r.scope === scope && r.kind === 'system',
      );
      return Promise.resolve(state === undefined ? null : Role.restore(state));
    },
    findById: (market, id) => {
      const state = this.roles.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId ? null : Role.restore(state),
      );
    },
    findBySeedCode: (market, scope, seedCode) => {
      const state = [...this.roles.values()].find(
        (r) => r.marketId === market.marketId && r.scope === scope && r.seedCode === seedCode,
      );
      return Promise.resolve(state === undefined ? null : Role.restore(state));
    },
    addSeeded: (_market, role) => {
      const state = role.state;
      const exists = [...this.roles.values()].some(
        (r) =>
          r.marketId === state.marketId &&
          r.scope === state.scope &&
          (r.seedCode === state.seedCode || (r.kind === 'system' && state.kind === 'system')),
      );
      if (exists) return Promise.resolve(false);
      this.roles.set(state.id, state);
      return Promise.resolve(true);
    },
    applySeed: (_market, upgrade) => {
      const state = upgrade.role.state;
      const stored = this.roles.get(state.id);
      if (stored === undefined || stored.version !== upgrade.role.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role', state.id));
      }
      this.roles.set(state.id, state);
      return Promise.resolve();
    },
  };

  /**
   * The grant read over the fake roles and assignments, as `PrismaRoleGrantReader` answers it:
   * each account's assigned role with its scope, kind, seller and stored keys.
   */
  readonly grantReader: RoleGrantReader = {
    grantsOf: (market, accountIds) => {
      const grants = new Map<Id<'Account'>, RoleGrant>();
      for (const accountId of accountIds) {
        const assignment = [...this.assignments.values()].find(
          (a) => a.marketId === market.marketId && a.accountId === accountId,
        );
        const role = assignment === undefined ? undefined : this.roles.get(assignment.roleId);
        if (role === undefined || role.marketId !== market.marketId) continue;
        grants.set(accountId, {
          roleId: role.id,
          kind: role.kind,
          scope: role.scope,
          sellerId: role.sellerId,
          storedKeys: role.kind === 'system' ? [] : role.permissionKeys,
        });
      }
      return Promise.resolve(grants);
    },
  };

  readonly assignmentRepository: RoleAssignmentRepository = {
    findByAccount: (market, accountId) => {
      const state = [...this.assignments.values()].find(
        (a) => a.marketId === market.marketId && a.accountId === accountId,
      );
      return Promise.resolve(state === undefined ? null : RoleAssignment.restore(state));
    },
    add: (_market, assignment) => {
      const state = assignment.state;
      if (
        [...this.assignments.values()].some(
          (a) => a.marketId === state.marketId && a.accountId === state.accountId,
        )
      ) {
        return Promise.reject(new Error('role_assignments_market_id_account_id_key'));
      }
      this.assignments.set(state.id, state);
      return Promise.resolve();
    },
    remove: (_market, assignment) => {
      const stored = this.assignments.get(assignment.state.id);
      if (stored === undefined || stored.version !== assignment.persistedVersion) {
        return Promise.reject(new StaleAggregateError('role-assignment', assignment.state.id));
      }
      this.assignments.delete(assignment.state.id);
      return Promise.resolve();
    },
  };

  readonly linkRepository: OneTimeLinkRepository = {
    findById: (market, id) => {
      const state = this.links.get(id);
      return Promise.resolve(
        state === undefined || state.marketId !== market.marketId
          ? null
          : OneTimeLink.restore(state),
      );
    },
    findFor: (market, accountId, purpose) => {
      const state = [...this.links.values()].find(
        (l) => l.marketId === market.marketId && l.accountId === accountId && l.purpose === purpose,
      );
      return Promise.resolve(state === undefined ? null : OneTimeLink.restore(state));
    },
    findByTokenHash: (market, tokenHash) => {
      const state = [...this.links.values()].find(
        (l) =>
          l.marketId === market.marketId &&
          l.tokenHash !== null &&
          hex(l.tokenHash) === hex(tokenHash),
      );
      return Promise.resolve(state === undefined ? null : OneTimeLink.restore(state));
    },
    add: (_market, link) => {
      this.links.set(link.state.id, link.state);
      return Promise.resolve();
    },
    save: (_market, link) => {
      const stored = this.links.get(link.state.id);
      if (stored === undefined || stored.version !== link.persistedVersion) {
        return Promise.reject(new StaleAggregateError('one-time-link', link.state.id));
      }
      this.links.set(link.state.id, link.state);
      return Promise.resolve();
    },
    consume: (market, id, expectedVersion, now) => {
      const stored = this.links.get(id);
      if (
        stored === undefined ||
        stored.marketId !== market.marketId ||
        stored.version !== expectedVersion ||
        stored.consumedAt !== null ||
        stored.expiresAt === null ||
        Temporal.Instant.compare(stored.expiresAt, now) <= 0
      ) {
        return Promise.resolve(false);
      }
      this.links.set(id, { ...stored, consumedAt: now, version: stored.version + 1 });
      return Promise.resolve(true);
    },
    cancelUnused: (market, accountId, purpose) => {
      const state = [...this.links.values()].find(
        (l) =>
          l.marketId === market.marketId &&
          l.accountId === accountId &&
          l.purpose === purpose &&
          l.consumedAt === null,
      );
      if (state === undefined) return Promise.resolve(false);
      this.links.set(state.id, {
        ...state,
        tokenHash: null,
        issuedAt: null,
        expiresAt: null,
        version: state.version + 1,
      });
      return Promise.resolve(true);
    },
    purgeSpent: () => Promise.resolve(0),
  };

  readonly mailTransport: MailTransport = {
    send: (message) => {
      if (this.mailDown) return Promise.reject(new Error('mail transport down'));
      this.mails.push(message);
      return Promise.resolve();
    },
  };

  readonly sessionRepository: SessionRepository = {
    add: (_market: MarketContext, session: Session, tokenHash: Uint8Array) => {
      this.sessions.set(session.id, { session, tokenHash: hex(tokenHash) });
      return Promise.resolve();
    },
    findForAuthentication: (market: MarketContext, tokenHash: Uint8Array) => {
      const found = [...this.sessions.values()].find(
        (s) => s.session.marketId === market.marketId && s.tokenHash === hex(tokenHash),
      );
      if (found === undefined) return Promise.resolve(null);
      const account = this.accounts.get(found.session.accountId)!;
      const membership = [...this.memberships.values()].find(
        (m) =>
          m.marketId === market.marketId &&
          m.accountId === found.session.accountId &&
          m.state === 'active',
      );
      const sellerId = found.session.sellerId;
      const access = sellerId === null ? undefined : this.sellerAccess.get(sellerId);
      const answer: SessionForAuthentication = {
        session: found.session,
        accountStatus: account.status,
        activeMembershipSellerId: membership?.sellerId ?? null,
        sellerAccessState:
          access === undefined || access.marketId !== market.marketId ? null : access.state,
      };
      return Promise.resolve(answer);
    },
    findById: (market: MarketContext, id: Id<'Session'>) => {
      const found = this.sessions.get(id);
      return Promise.resolve(
        found === undefined || found.session.marketId !== market.marketId ? null : found.session,
      );
    },
    touch: (_market, id, now, lastSeenBefore) => {
      const found = this.sessions.get(id);
      if (
        found !== undefined &&
        found.session.revokedAt === null &&
        Temporal.Instant.compare(found.session.lastSeenAt, lastSeenBefore) <= 0
      ) {
        found.session = { ...found.session, lastSeenAt: now };
      }
      return Promise.resolve();
    },
    revoke: (market, id, accountId, reason, now) => {
      const found = this.sessions.get(id);
      if (
        found === undefined ||
        found.session.marketId !== market.marketId ||
        found.session.accountId !== accountId ||
        found.session.revokedAt !== null
      ) {
        return Promise.resolve(false);
      }
      found.session = { ...found.session, revokedAt: now, revokedReason: reason };
      return Promise.resolve(true);
    },
    revokeAllOf: (market, accountId, reason, now, exceptId) => {
      let count = 0;
      for (const found of this.sessions.values()) {
        const s = found.session;
        if (
          s.marketId === market.marketId &&
          s.accountId === accountId &&
          s.revokedAt === null &&
          s.id !== exceptId
        ) {
          found.session = { ...s, revokedAt: now, revokedReason: reason };
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    rotate: (market, id, accountId, tokenHash) => {
      const found = this.sessions.get(id);
      if (
        found === undefined ||
        found.session.marketId !== market.marketId ||
        found.session.accountId !== accountId ||
        found.session.revokedAt !== null
      ) {
        return Promise.resolve(false);
      }
      found.tokenHash = hex(tokenHash);
      return Promise.resolve(true);
    },
    purgeExpired: () => Promise.resolve(0),
  };

  readonly throttleRepository: ThrottleRepository = {
    reserve: (market: MarketContext, counters: readonly ThrottleCounter[], now) => {
      if (this.throttlesDown) return Promise.reject(new Error('counter table unreachable'));
      return Promise.resolve(
        counters.map((counter) => {
          const key = `${market.marketId}|${counter.kind}|${hex(counter.keyHash)}`;
          const existing = this.throttles.get(key);
          const created: ThrottleReservation & { accountKey: string | null } = {
            kind: counter.kind,
            keyHash: counter.keyHash,
            accountKey: counter.accountKey === null ? null : hex(counter.accountKey),
            attempts: 0,
            windowStartedAt: now,
            blockedUntil: null,
          };
          let row = existing ?? created;
          if (
            existing !== undefined &&
            Temporal.Instant.compare(row.windowStartedAt, windowRestartBefore(counter.rule, now)) <=
              0
          ) {
            row = { ...row, attempts: 0, windowStartedAt: now };
          }
          row = { ...row, attempts: row.attempts + 1 };
          this.throttles.set(key, row);
          const reservation: ThrottleReservation = {
            kind: row.kind,
            keyHash: row.keyHash,
            attempts: row.attempts,
            windowStartedAt: row.windowStartedAt,
            blockedUntil: row.blockedUntil,
          };
          return reservation;
        }),
      );
    },
    release: (market, reservations) => {
      for (const r of reservations) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (
          row !== undefined &&
          row.attempts > 0 &&
          row.windowStartedAt.equals(r.windowStartedAt)
        ) {
          this.throttles.set(key, { ...row, attempts: row.attempts - 1 });
        }
      }
      return Promise.resolve();
    },
    block: (market, blocks) => {
      for (const { reservation: r, until } of blocks) {
        const key = `${market.marketId}|${r.kind}|${hex(r.keyHash)}`;
        const row = this.throttles.get(key);
        if (row !== undefined && row.windowStartedAt.equals(r.windowStartedAt)) {
          this.throttles.set(key, { ...row, blockedUntil: until });
        }
      }
      return Promise.resolve();
    },
    clearAccount: (market, accountKey) => {
      let count = 0;
      for (const [key, row] of this.throttles) {
        if (
          key.startsWith(`${market.marketId}|`) &&
          row.accountKey === hex(accountKey) &&
          (row.kind === 'sign-in.account' || row.kind === 'sign-in.account-origin')
        ) {
          this.throttles.delete(key);
          count += 1;
        }
      }
      return Promise.resolve(count);
    },
    purge: () => Promise.resolve(0),
  };

  readonly recordRepository: SignInRecordRepository = {
    add: (market, record) => {
      this.records.push({ ...record, marketId: market.marketId });
      return Promise.resolve();
    },
    oldest: () => Promise.resolve(null),
    deleteBetween: () => Promise.resolve(0),
  };

  readonly outbox: OutboxWriter = {
    append: (_context, events) => {
      this.events.push(...events);
      return Promise.resolve();
    },
  };

  /**
   * Identity's audit writer without a database: it records what it is given (the real writer
   * needs an open unit of the persistence layer; test/db/ covers it).
   */
  readonly audit: AuditWriter = {
    record: (context: CallContext, entry: AuditEntry) => {
      this.audits.push({
        ...entry,
        actor: context.actor.kind,
        marketId: context.market.marketId,
      });
      return Promise.resolve();
    },
  };

  readonly hasher: PasswordHasher = {
    hash: (plain: string): Promise<Result<string, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.hashed += 1;
      return Promise.resolve(ok(fakeHashOf(plain)));
    },
    verify: (
      plain: string,
      stored: string | null,
    ): Promise<Result<PasswordVerification, PasswordHasherBusy>> => {
      if (this.busy) return Promise.resolve(err({ code: 'request.busy', retryAfterSeconds: 1 }));
      this.verified += 1;
      return Promise.resolve(
        ok({
          matches: stored !== null && stored === fakeHashOf(plain),
          needsRehash: this.needsRehash && stored === fakeHashOf(plain),
        }),
      );
    },
  };

  /** Replaces every database port of identity, and the hasher, with these fakes. */
  override(builder: TestingModuleBuilder): TestingModuleBuilder {
    return builder
      .overrideProvider(UNIT_OF_WORK)
      .useValue(this.unitOfWork)
      .overrideProvider(ACCOUNT_REPOSITORY)
      .useValue(this.accountRepository)
      .overrideProvider(SESSION_REPOSITORY)
      .useValue(this.sessionRepository)
      .overrideProvider(THROTTLE_REPOSITORY)
      .useValue(this.throttleRepository)
      .overrideProvider(SIGN_IN_RECORD_REPOSITORY)
      .useValue(this.recordRepository)
      .overrideProvider(OUTBOX_WRITER)
      .useValue(this.outbox)
      .overrideProvider(AUDIT_WRITER)
      .useValue(this.audit)
      .overrideProvider(ONE_TIME_LINK_REPOSITORY)
      .useValue(this.linkRepository)
      .overrideProvider(SELLER_ACCESS_REPOSITORY)
      .useValue(this.sellerAccessRepository)
      .overrideProvider(REVIEWER_CANDIDATE_READER)
      .useValue(this.reviewerCandidateReader)
      .overrideProvider(SELLER_MEMBERSHIP_REPOSITORY)
      .useValue(this.membershipRepository)
      .overrideProvider(ROLE_REPOSITORY)
      .useValue(this.roleRepository)
      .overrideProvider(ROLE_ASSIGNMENT_REPOSITORY)
      .useValue(this.assignmentRepository)
      .overrideProvider(ROLE_GRANT_READER)
      .useValue(this.grantReader)
      .overrideProvider(MAIL_TRANSPORT)
      .useValue(this.mailTransport)
      .overrideProvider(PASSWORD_HASHER)
      .useValue(this.hasher);
  }
}
