import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { Account } from '../../domain/account';
import { AgentInvitationAcceptedAudit, SecondFactorActivatedAudit } from '../../domain/audit';
import { normaliseHandoverCode } from '../../domain/handover-code';
import { decodeBase32Secret } from '../../domain/otpauth';
import {
  checkNewPassword,
  MAX_PASSWORD_BYTES,
  type PasswordRejected,
} from '../../domain/password-policy';
import { displayRecoveryCode, type RecoveryCode } from '../../domain/recovery-code';
import { SecondFactor } from '../../domain/second-factor';
import { blockAfterFailure, reservationVerdict } from '../../domain/throttle';
import { candidateSteps, parseTotpCode } from '../../domain/totp';
import type { AccountRepository } from '../ports/account.repository';
import type { CommonPasswordList } from '../ports/common-password-list';
import type { HandoverCodes } from '../ports/handover-codes';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { InvitationRepository } from '../ports/invitation.repository';
import type { PasswordHasher, PasswordHasherBusy } from '../ports/password-hasher';
import type { EnrolmentSecretTags, OpaqueTokens } from '../ports/second-factor-tokens';
import type { SecondFactorSecrets } from '../ports/second-factor-secrets';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import {
  newRecoveryCodes,
  reserveSecondFactor,
  secondFactorCounter,
  type ReservedAttempt,
} from '../second-factor/code-check';
import { acceptableAgentInvitation } from '../second-factor/invitation-lookup';
import type { SignInClient } from '../sign-in/sign-in-flow';
import type { FieldProblem } from './register-customer.use-case';

export interface AcceptAgentInvitationInput {
  /** The token from the fragment of the invitation's link. */
  readonly token: string;
  /** The handover code the admin gave the agent directly: as typed, shown once at issue. */
  readonly handoverCode: string;
  readonly password: string;
  /** The secret, its tag and its expiry, as the preview returned them. */
  readonly secret: string;
  readonly tag: string;
  readonly expiresAt: string;
  /** The first code from the app, for that secret. */
  readonly code: string;
  readonly client: SignInClient;
}

/** The account exists with an active factor. The recovery codes are shown once, here. */
export interface AcceptAgentInvitationOutput {
  readonly code: 'invitation.accepted';
  readonly accountId: Id<'Account'>;
  readonly recoveryCodes: readonly string[];
}

export type AcceptAgentInvitationFailure =
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldProblem[] }
  /** Unknown, used, revoked, expired, voided or other-kind link token: one answer for all. */
  | { readonly code: 'invitation.rejected' }
  /** The link token is good and the handover code is wrong; the fifth failure voids the code. */
  | { readonly code: 'handover-code.invalid' }
  | { readonly code: 'invitation.enrolment-expired' }
  | PasswordRejected
  | { readonly code: 'second-factor.invalid' }
  | { readonly code: 'second-factor.locked'; readonly retryAfterSeconds: number }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | PasswordHasherBusy
  | { readonly code: 'access.unavailable' };

export interface AcceptAgentInvitationDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly invitations: InvitationRepository;
  readonly factors: SecondFactorRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly invitationTokens: OpaqueTokens;
  readonly enrolmentTags: EnrolmentSecretTags;
  readonly secrets: SecondFactorSecrets;
  readonly codes: HandoverCodes;
  readonly hasher: PasswordHasher;
  readonly commonPasswords: CommonPasswordList;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const REJECTED = Object.freeze({ code: 'invitation.rejected' as const });
const WRONG_CODE = Object.freeze({ code: 'handover-code.invalid' as const });
const EXPIRED = Object.freeze({ code: 'invitation.enrolment-expired' as const });
const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * Accepts an agent invitation in ONE request (ADR-0045 decision 2): the emailed link token, the
 * handover code the admin gave the agent directly, the password and the first second-factor code
 * together. Neither the link nor the code alone accepts, so neither a mailbox compromise nor the
 * inviting admin alone can take the account. Rule `anonymous`; no session opens (the agent signs
 * in afterwards, second factor mandatory).
 *
 * 1. **Reservation unit**: `sign-in.origin` counted (the route also counts under the anonymous
 *    per-origin limit), the invitation read by the hash of its token. An unusable one (unknown,
 *    used, revoked, expired, voided or another kind) is `invitation.rejected`, the count kept, so
 *    guesses cannot be spread across invitations. The handover code is then presented: a wrong
 *    one is counted on the invitation (the unit commits; the fifth failure voids the code for
 *    good, and the origin count stays) and answers `handover-code.invalid`; a right one gives the
 *    origin count back, and the `second-factor.account` counter of the address is reserved.
 * 2. Outside any unit: the secret's tag and expiry, the password's rules against the address and
 *    the invitation's name, the first code against the presented secret, the password's hash.
 * 3. **Closing unit**, SERIALIZABLE: the invitation read again, usable, the code matched again
 *    (`Invitation.acceptAgent`: the domain refuses without the code), the account created `active`
 *    and verified under the id the invitation reserved, the secret sealed, ten recovery codes
 *    hashed, the factor `active` with the code's step spent, the invitation accepted (address,
 *    name and code cleared). Events: `invitation-accepted` and `second-factor-changed`. Audit,
 *    `ANONYMOUS` bound to the invitation: `identity.agent-invitation.accepted` with the inviter's
 *    account id, and `identity.second-factor.activated`.
 *
 * The handover code, the token, the secret, the password, the name and the address are never
 * logged.
 */
export class AcceptAgentInvitation extends UseCase<
  AcceptAgentInvitationInput,
  AcceptAgentInvitationOutput,
  AcceptAgentInvitationFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.accept-agent-invitation',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('AcceptAgentInvitation');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AcceptAgentInvitationDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AcceptAgentInvitationInput,
  ): Promise<Result<AcceptAgentInvitationOutput, AcceptAgentInvitationFailure>> {
    const { market } = context;
    // Shapes first: nothing is counted for a malformed request.
    const fields: FieldProblem[] = [];
    const handover = normaliseHandoverCode(input.handoverCode);
    if (handover === null) fields.push({ path: 'handoverCode', code: 'format' });
    if (
      typeof input.password !== 'string' ||
      Buffer.byteLength(input.password, 'utf8') > MAX_PASSWORD_BYTES
    ) {
      fields.push({ path: 'password', code: 'length' });
    }
    const secret = decodeBase32Secret(input.secret);
    if (secret === null) fields.push({ path: 'secret', code: 'format' });
    const expiresAt = parseInstant(input.expiresAt);
    if (expiresAt === null) fields.push({ path: 'expiresAt', code: 'format' });
    const code = parseTotpCode(input.code);
    if (code === null) fields.push({ path: 'code', code: 'format' });
    if (typeof input.tag !== 'string' || input.tag.length === 0 || input.tag.length > 128) {
      fields.push({ path: 'tag', code: 'format' });
    }
    if (
      handover === null ||
      secret === null ||
      expiresAt === null ||
      code === null ||
      fields.length > 0
    ) {
      secret?.fill(0);
      return err({ code: 'validation.failed', fields });
    }
    const throttle = this.deps.policy.secondFactorThrottle(market);
    if (throttle === null) {
      secret.fill(0);
      return err(UNAVAILABLE);
    }
    try {
      return await this.accept(context, input, { handover, secret, expiresAt, code, throttle });
    } finally {
      secret.fill(0);
    }
  }

  private async accept(
    context: CallContext,
    input: AcceptAgentInvitationInput,
    parsed: {
      readonly handover: string;
      readonly secret: Uint8Array;
      readonly expiresAt: Temporal.Instant;
      readonly code: string;
      readonly throttle: NonNullable<ReturnType<IdentityMarketPolicy['secondFactorThrottle']>>;
    },
  ): Promise<Result<AcceptAgentInvitationOutput, AcceptAgentInvitationFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const origin: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };

    type Reserved =
      | { readonly kind: 'refused'; readonly refusal: AcceptAgentInvitationFailure }
      | {
          readonly kind: 'reserved';
          readonly invitationId: Id<'Invitation'>;
          readonly email: { readonly typed: string; readonly normalized: string };
          readonly displayName: string;
          readonly attempt: ReservedAttempt;
        };
    let reserved: Reserved;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Reserved, never>> => {
        const now = this.deps.clock.now();
        const [reservation] = await throttles.reserve(market, [origin], now);
        const verdict = reservationVerdict([{ reservation: reservation!, rule: origin.rule }], now);
        if (!verdict.allowed) {
          return ok({
            kind: 'refused',
            refusal: { code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds },
          });
        }
        const found =
          tokenHash === null
            ? null
            : await this.deps.invitations.findByTokenHash(market, tokenHash);
        // Concurrent attempts on one invitation run one after the other: the row lock is taken
        // first and the invitation read again, so no failed attempt is lost and the cap of five
        // is strict.
        const invitation =
          found !== null && (await this.deps.invitations.lockForAttempt(market, found.state.id))
            ? await this.deps.invitations.findById(market, found.state.id)
            : null;
        if (!acceptableAgentInvitation(invitation, now)) {
          return ok({ kind: 'refused', refusal: REJECTED });
        }
        const stored = invitation.state.handoverCodeHmac;
        const matched =
          stored !== null &&
          this.deps.codes.matches(market, invitation.state.id, parsed.handover, stored);
        if (!invitation.presentHandoverCode(matched, now).ok) {
          // The failed attempt is committed (the unit returns ok) and the origin count stays.
          await this.deps.invitations.save(market, invitation);
          return ok({ kind: 'refused', refusal: WRONG_CODE });
        }
        await throttles.release(market, [reservation!]);
        const email = invitation.state.email!;
        const counter = secondFactorCounter(
          keys,
          market,
          'agent',
          email.normalized,
          parsed.throttle,
        );
        const attempt = await reserveSecondFactor(throttles, market, counter, now);
        if (attempt.kind === 'locked') {
          return ok({
            kind: 'refused',
            refusal: { code: 'second-factor.locked', retryAfterSeconds: attempt.retryAfterSeconds },
          });
        }
        return ok({
          kind: 'reserved',
          invitationId: invitation.state.id,
          email: { typed: email.typed, normalized: email.normalized },
          displayName: invitation.state.displayName!,
          attempt: attempt.reserved,
        });
      });
      if (!run.ok) return err(UNAVAILABLE);
      reserved = run.value;
    } catch {
      this.log('identity.accept-agent-invitation.unavailable', context, {});
      return err(UNAVAILABLE);
    }
    if (reserved.kind === 'refused') {
      this.log('identity.accept-agent-invitation.refused', context, {
        reason: reserved.refusal.code,
      });
      return err(reserved.refusal);
    }
    const { invitationId, email, displayName, attempt } = reserved;

    // 2. Outside any unit: the tag, the password's rules, the code, the hash.
    const now = this.deps.clock.now();
    if (
      Temporal.Instant.compare(now, parsed.expiresAt) >= 0 ||
      !this.deps.enrolmentTags.matches(
        market,
        invitationId,
        parsed.secret,
        parsed.expiresAt,
        input.tag,
      )
    ) {
      return this.releasing(context, attempt, EXPIRED);
    }
    const checked = checkNewPassword(
      input.password,
      policy.passwordRules(market),
      { email: email.normalized, displayName },
      (comparable) => this.deps.commonPasswords.isCommon(comparable),
    );
    if (!checked.ok) return this.releasing(context, attempt, checked.error);
    const step = this.deps.secrets.matchPlain(parsed.secret, parsed.code, candidateSteps(now));
    if (step === null) {
      const blocked = await this.quietly(context, () =>
        unitOfWork.run(market, async () => {
          const until = blockAfterFailure(attempt.reservation, attempt.rule, this.deps.clock.now());
          if (until !== null) {
            await throttles.block(market, [{ reservation: attempt.reservation, until }]);
          }
          return ok(undefined);
        }),
      );
      this.log('identity.accept-agent-invitation.code-invalid', context, { invitationId });
      return err(blocked ? { code: 'second-factor.invalid' } : UNAVAILABLE);
    }
    const hashed = await this.deps.hasher.hash(input.password);
    if (!hashed.ok) return this.releasing(context, attempt, hashed.error);

    // 3. The closing unit.
    type Closed =
      | {
          readonly kind: 'accepted';
          readonly accountId: Id<'Account'>;
          readonly codes: readonly RecoveryCode[];
        }
      | { readonly kind: 'refused' };
    let closed: Result<Closed, never>;
    try {
      closed = await unitOfWork.run(
        market,
        async (): Promise<Result<Closed, never>> => {
          const now = this.deps.clock.now();
          const refuse = async (): Promise<Result<Closed, never>> => {
            await throttles.release(market, [attempt.reservation]);
            return ok({ kind: 'refused' });
          };
          const invitation = await this.deps.invitations.findById(market, invitationId);
          if (!acceptableAgentInvitation(invitation, now)) return refuse();
          const accountId = invitation.state.agentAccountId;
          const inviterId = invitation.state.invitedByAccountId;
          const stored = invitation.state.handoverCodeHmac;
          if (accountId === null || inviterId === null || stored === null) return refuse();
          const matched = this.deps.codes.matches(market, invitationId, parsed.handover, stored);
          const account = Account.acceptInvitation({
            id: accountId,
            marketId: market.marketId,
            population: 'agent',
            email: invitation.state.email!,
            displayName,
            passwordHash: hashed.value,
            now,
          });
          // The domain refuses without the code; the invitation is decided before anything is
          // written, so a refusal here leaves no account behind.
          if (!invitation.acceptAgent(accountId, matched, now).ok) return refuse();
          const added = await this.deps.accounts.add(market, account);
          if (!added.ok) return refuse();
          // The account's key exists in this unit only: sealing and hashing read it here.
          const sealed = await this.deps.secrets.seal(market, accountId, parsed.secret);
          const fresh = await newRecoveryCodes(this.deps.secrets, market, accountId);
          const factor = SecondFactor.createActive({
            id: this.deps.ids.next<'SecondFactor'>(),
            marketId: market.marketId,
            accountId,
            secretCiphertext: sealed,
            acceptedStep: step,
            recoveryCodeHashes: fresh.hashes,
            now,
          });
          await this.deps.factors.add(market, factor);
          await this.deps.invitations.save(market, invitation);
          await this.deps.outbox.append(context, [
            ...invitation.pendingEvents,
            ...factor.pendingEvents,
          ]);
          const bound = { accountId, boundSubjectId: invitationId };
          await this.deps.audit.record(
            context,
            AgentInvitationAcceptedAudit.entry(invitationId, {
              after: { ...bound, invitedByAccountId: inviterId },
            }),
          );
          await this.deps.audit.record(
            context,
            SecondFactorActivatedAudit.entry(factor.state.id, { after: bound }),
          );
          await throttles.release(market, [attempt.reservation]);
          return ok({ kind: 'accepted', accountId, codes: fresh.codes });
        },
        { isolation: 'serializable' },
      );
    } catch (error) {
      this.log('identity.accept-agent-invitation.closing-failed', context, { invitationId });
      await this.release(context, attempt);
      throw error;
    }
    if (!closed.ok || closed.value.kind === 'refused') {
      this.log('identity.accept-agent-invitation.refused', context, {
        invitationId,
        reason: REJECTED.code,
      });
      return err(REJECTED);
    }
    this.log('identity.accept-agent-invitation.accepted', context, {
      invitationId,
      accountId: closed.value.accountId,
    });
    return ok({
      code: 'invitation.accepted',
      accountId: closed.value.accountId,
      recoveryCodes: closed.value.codes.map(displayRecoveryCode),
    });
  }

  /** Gives the attempt back (no code was tried) and answers `failure`. */
  private async releasing<F extends AcceptAgentInvitationFailure>(
    context: CallContext,
    attempt: ReservedAttempt,
    failure: F,
  ): Promise<Result<never, F | typeof UNAVAILABLE>> {
    return err((await this.release(context, attempt)) ? failure : UNAVAILABLE);
  }

  private release(context: CallContext, attempt: ReservedAttempt): Promise<boolean> {
    return this.quietly(context, () =>
      this.deps.unitOfWork.run(context.market, async () => {
        await this.deps.throttles.release(context.market, [attempt.reservation]);
        return ok(undefined);
      }),
    );
  }

  private async quietly(
    context: CallContext,
    run: () => Promise<Result<void, never>>,
  ): Promise<boolean> {
    try {
      return (await run()).ok;
    } catch {
      this.log('identity.accept-agent-invitation.unit-unavailable', context, {});
      return false;
    }
  }

  /** Ids and codes only: never the token, the handover code, the secret, the name or the address. */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}

/** An ISO 8601 instant, or null. */
function parseInstant(raw: unknown): Temporal.Instant | null {
  if (typeof raw !== 'string' || raw.length > 40) return null;
  try {
    return Temporal.Instant.from(raw);
  } catch {
    return null;
  }
}
