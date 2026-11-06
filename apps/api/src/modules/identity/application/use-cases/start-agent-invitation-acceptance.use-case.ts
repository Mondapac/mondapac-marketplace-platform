import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { encodeBase32, otpauthUri } from '../../domain/otpauth';
import { reservationVerdict } from '../../domain/throttle';
import {
  acceptableAgentInvitation,
  ENROLMENT_SECRET_MINUTES,
} from '../second-factor/invitation-lookup';
import type { ThrottleCounter } from '../ports/throttle.repository';
import type { EnrolmentSecretTags } from '../ports/second-factor-tokens';
import type {
  StartAdminInvitationAcceptanceDependencies,
  StartAdminInvitationAcceptanceInput,
  StartAdminInvitationAcceptanceOutput,
} from './start-admin-invitation-acceptance.use-case';

export type StartAgentInvitationAcceptanceInput = StartAdminInvitationAcceptanceInput;
export type StartAgentInvitationAcceptanceOutput = StartAdminInvitationAcceptanceOutput;
export type StartAgentInvitationAcceptanceFailure =
  | { readonly code: 'invitation.rejected' }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'access.unavailable' };

/**
 * The preview of an agent's acceptance (ADR-0045 decision 2, as the admin's HF6 start): a new
 * secret with its tag and expiry for the authenticator app, so the one accepting request can
 * carry the first code. Rule `anonymous`: the link token is the credential, and it alone accepts
 * nothing: the handover code is checked only by the accepting request. The request counts on
 * `sign-in.origin` as every token guess does; an unknown, used, revoked, expired, voided or
 * other-kind token answers `invitation.rejected`, the same for each. Nothing is stored.
 */
export class StartAgentInvitationAcceptance extends UseCase<
  StartAgentInvitationAcceptanceInput,
  StartAgentInvitationAcceptanceOutput,
  StartAgentInvitationAcceptanceFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.start-agent-invitation-acceptance',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('StartAgentInvitationAcceptance');

  constructor(
    gate: UseCaseGate,
    private readonly deps: StartAdminInvitationAcceptanceDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: StartAgentInvitationAcceptanceInput,
  ): Promise<Result<StartAgentInvitationAcceptanceOutput, StartAgentInvitationAcceptanceFailure>> {
    const { market } = context;
    const { unitOfWork, throttles, keys, policy } = this.deps;
    const tokenHash = this.deps.invitationTokens.hashOf(input.token);
    const counter: ThrottleCounter = {
      kind: 'sign-in.origin',
      keyHash: keys.origin(market, input.client.origin),
      accountKey: null,
      rule: policy.signInThrottles(market).origin,
    };
    type Found = {
      readonly invitationId: string | null;
      readonly email: string | null;
      readonly throttled: number | null;
    };
    let found: Found;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Found, never>> => {
        const now = this.deps.clock.now();
        const [reservation] = await throttles.reserve(market, [counter], now);
        const verdict = reservationVerdict(
          [{ reservation: reservation!, rule: counter.rule }],
          now,
        );
        if (!verdict.allowed) {
          return ok({ invitationId: null, email: null, throttled: verdict.retryAfterSeconds });
        }
        const invitation =
          tokenHash === null
            ? null
            : await this.deps.invitations.findByTokenHash(market, tokenHash);
        if (!acceptableAgentInvitation(invitation, now)) {
          return ok({ invitationId: null, email: null, throttled: null });
        }
        await throttles.release(market, [reservation!]);
        return ok({
          invitationId: invitation.state.id,
          email: invitation.state.email!.typed,
          throttled: null,
        });
      });
      if (!run.ok) return err({ code: 'access.unavailable' });
      found = run.value;
    } catch {
      this.log('identity.agent-invitation-acceptance.unavailable', context, {});
      return err({ code: 'access.unavailable' });
    }
    if (found.throttled !== null) {
      return err({ code: 'request.throttled', retryAfterSeconds: found.throttled });
    }
    if (found.invitationId === null || found.email === null) {
      this.log('identity.agent-invitation-acceptance.rejected', context, {});
      return err({ code: 'invitation.rejected' });
    }
    const invitationId = found.invitationId as Parameters<EnrolmentSecretTags['tag']>[1];
    const expiresAt = this.deps.clock.now().add({ minutes: ENROLMENT_SECRET_MINUTES });
    const secret = this.deps.secrets.newSecret();
    try {
      const output: StartAgentInvitationAcceptanceOutput = {
        code: 'invitation.enrolment-ready',
        secret: encodeBase32(secret),
        otpauthUri: otpauthUri({
          issuer: policy.mailSender(market).name,
          accountName: found.email,
          secret,
        }),
        tag: this.deps.enrolmentTags.tag(market, invitationId, secret, expiresAt),
        expiresAt,
      };
      this.log('identity.agent-invitation-acceptance.started', context, { invitationId });
      return ok(output);
    } finally {
      secret.fill(0);
    }
  }

  /** Ids and codes only: never the token, the secret or the address (P 12.3). */
  private log(msg: string, context: CallContext, fields: Record<string, string>): void {
    this.#logger.log({
      msg,
      ...fields,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
  }
}
