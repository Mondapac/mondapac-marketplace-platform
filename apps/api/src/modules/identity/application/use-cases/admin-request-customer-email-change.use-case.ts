import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type {
  CallContext,
  Clock,
  Id,
  IdGenerator,
  Result,
  Temporal,
} from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import {
  UseCase,
  type AccessDeclaration,
  type PermissionKey,
  type StepUpActionRegistry,
  type UseCaseGate,
} from '../../../../platform/authz';
import { AccountEmailChangeRequestedAudit } from '../../domain/audit';
import { parseEmailAddress } from '../../domain/email-address';
import { OneTimeLink } from '../../domain/one-time-link';
import { reservationVerdict } from '../../domain/throttle';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { LinkTargets } from '../ports/link-secrets';
import type { OneTimeLinkRepository } from '../ports/one-time-link.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SecondFactorRepository } from '../ports/second-factor.repository';
import type { ThrottleKeys } from '../ports/session-secrets';
import type { StepUpRepository } from '../ports/step-up.repository';
import type { ThrottleCounter, ThrottleRepository } from '../ports/throttle.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';
import { isActingAsSession } from '../sellers/access-decision-reads';
import { AdminStepUpConsumer } from '../step-up/admin-step-up-consumer';

/**
 * customers' protected key and step-up action of the email change (Hassan R4); only the declaring
 * module can brand a key, so it is cast here and a contract test pins it to the declaration.
 */
export const CUSTOMER_EMAIL_CHANGE_KEY = 'customers.customer-email.change' as PermissionKey;

/** The link of the change (Mohammad 7: lifetime and page must exist before anything is written). */
export const EMAIL_CHANGE_PURPOSE = 'confirm-email-change' as const;

export interface AdminRequestCustomerEmailChangeInput {
  readonly accountId: Id<'Account'>;
  /** As typed; parsed here with the registration's parser (Hassan R5). Never logged. */
  readonly email: string;
  /** The IPv4 address or the IPv6 /64 of the admin's client (ADR-0037): the `mail.origin` key. */
  readonly origin: string;
}

export interface AdminRequestCustomerEmailChangeOutput {
  /** False when the address is the account's current one: nothing was written or spent. */
  readonly changed: boolean;
  /** When the change was asked for (the pending request's instant); null when unchanged. */
  readonly requestedAt: Temporal.Instant | null;
}

export type AdminRequestCustomerEmailChangeFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'account.unknown' }
  | { readonly code: 'account.not-eligible' }
  | { readonly code: 'account.email-taken' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    }
  | { readonly code: 'request.throttled'; readonly retryAfterSeconds: number }
  | { readonly code: 'second-factor.required'; readonly actionKey: string }
  | { readonly code: 'second-factor.enrolment-required'; readonly actionKey: string };

export interface AdminRequestCustomerEmailChangeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
  readonly links: OneTimeLinkRepository;
  readonly throttles: ThrottleRepository;
  readonly keys: ThrottleKeys;
  readonly targets: LinkTargets;
  readonly policy: IdentityMarketPolicy;
  readonly stepUp: StepUpRepository;
  readonly stepUpActions: Pick<StepUpActionRegistry, 'get'>;
  readonly factors: SecondFactorRepository;
  readonly outbox: OutboxWriter;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/** A platform admin on a real admin session: not acting as a seller (R4: refused in both modules). */
export function isPlainAdmin(context: CallContext): boolean {
  const { actor } = context;
  return (
    actor.kind === 'authenticated' &&
    actor.population === 'admin' &&
    actor.sellerId === null &&
    !isActingAsSession(actor)
  );
}

/** The Market configures the change's link: its lifetime and its storefront page (Mohammad 7). */
export function emailChangeConfigured(
  deps: Pick<AdminRequestCustomerEmailChangeDependencies, 'policy' | 'targets'>,
  context: CallContext,
): boolean {
  return (
    deps.policy.linkLifetimeMinutes(context.market, EMAIL_CHANGE_PURPOSE) !== null &&
    deps.targets.target(context.market, 'customer', EMAIL_CHANGE_PURPOSE) !== null
  );
}

/**
 * `identity.admin-request-customer-email-change`: an admin asks to change a customer's sign-in
 * email (customers admin email change; design note with Mohammad's and Hassan's reviews). Rule
 * `permissions [customers.customer-email.change]` (customers' protected key, R4), checked by the
 * gate and again in the unit (C1); a platform admin that is not acting as a seller only. Not
 * exposed over HTTP: customers' route calls it through the facade.
 *
 * Before any unit: the address is parsed with the registration's parser (R5), and the Market must
 * configure the link's lifetime and page (else `access.unavailable`, nothing written). One
 * read-write unit:
 *
 * 1. the admin is still an active, verified admin holding the key (else `access.denied`);
 * 2. a customer account of this Market (else `account.unknown`), active and verified (else
 *    `account.not-eligible`); the current address again is `{ changed: false }`, nothing spent;
 * 3. another customer account of the Market holds the address, verified or not, is
 *    `account.email-taken` (admins can already find customers by address);
 * 4. the mail counters (R5): the customer's address and the admin's own address on
 *    `mail.account`, the admin's client on `mail.origin`; a refusal is `request.throttled` and
 *    commits nothing;
 * 5. the admin's fresh step-up proof of `customers.customer-email.change` is spent (R4);
 * 6. the account stores the pending address (one version step,
 *    `identity.account-email-change-requested.v1`); a newer request replaces an older one;
 * 7. the `confirm-email-change` link is requested (again), at the same instant, so it is bound to
 *    this request (R2) and an older token stops working; `identity.one-time-link-requested.v1`;
 * 8. the audit row `identity.account.email-change-requested` names the admin's step-up session.
 *
 * A concurrent change of the account answers `access.unavailable`. The address is never logged,
 * audited or put in an event.
 */
export class AdminRequestCustomerEmailChange extends UseCase<
  AdminRequestCustomerEmailChangeInput,
  AdminRequestCustomerEmailChangeOutput,
  AdminRequestCustomerEmailChangeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.admin-request-customer-email-change',
    rule: { kind: 'permissions', allOf: [CUSTOMER_EMAIL_CHANGE_KEY] },
  };

  readonly #logger = new Logger('AdminRequestCustomerEmailChange');
  readonly #stepUp: AdminStepUpConsumer;

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminRequestCustomerEmailChangeDependencies,
  ) {
    super(gate);
    this.#stepUp = new AdminStepUpConsumer(deps);
  }

  protected async handle(
    context: CallContext,
    input: AdminRequestCustomerEmailChangeInput,
  ): Promise<
    Result<AdminRequestCustomerEmailChangeOutput, AdminRequestCustomerEmailChangeFailure>
  > {
    const result = await this.#handle(context, input);
    this.#logger.log({
      msg: 'identity.admin-request-customer-email-change',
      outcome: result.ok ? (result.value.changed ? 'requested' : 'unchanged') : result.error.code,
      accountId: input.accountId,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #handle(
    context: CallContext,
    input: AdminRequestCustomerEmailChangeInput,
  ): Promise<
    Result<AdminRequestCustomerEmailChangeOutput, AdminRequestCustomerEmailChangeFailure>
  > {
    const { market, actor } = context;
    if (!isPlainAdmin(context) || actor.kind !== 'authenticated') {
      return err({ code: 'access.denied' });
    }
    const email = parseEmailAddress(input.email);
    if (!email.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'email', code: 'invalid' }] });
    }
    const { deps } = this;
    if (!emailChangeConfigured(deps, context)) return err({ code: 'access.unavailable' });
    const self: GrantSubject = { accountId: actor.accountId, population: 'admin', sellerId: null };
    try {
      return await deps.unitOfWork.run(
        market,
        async (): Promise<
          Result<AdminRequestCustomerEmailChangeOutput, AdminRequestCustomerEmailChangeFailure>
        > => {
          const now = deps.clock.now();
          // C1: the actor is still an active admin holding the rule's key, read in this unit.
          const reading = await readActingGrants(
            deps,
            market,
            self,
            [],
            [CUSTOMER_EMAIL_CHANGE_KEY],
          );
          const admin = await deps.accounts.findById(market, actor.accountId);
          if (reading === null || admin === null) return err({ code: 'access.denied' });
          const account = await deps.accounts.findById(market, input.accountId);
          if (account === null || account.state.population !== 'customer') {
            return err({ code: 'account.unknown' });
          }
          if (account.state.status !== 'active' || !account.isEmailVerified) {
            return err({ code: 'account.not-eligible' });
          }
          if (email.value.normalized === account.state.email.normalized) {
            return ok({ changed: false, requestedAt: null });
          }
          const holder = await deps.accounts.findByEmail(
            market,
            'customer',
            email.value.normalized,
          );
          if (holder !== null && holder.state.id !== account.state.id) {
            return err({ code: 'account.email-taken' });
          }
          const rules = deps.policy.mailThrottles(market);
          const customerKey = deps.keys.account(market, 'customer', account.state.email.normalized);
          const adminKey = deps.keys.account(market, 'admin', admin.state.email.normalized);
          const counters: readonly ThrottleCounter[] = [
            {
              kind: 'mail.account',
              keyHash: customerKey,
              accountKey: customerKey,
              rule: rules.account,
            },
            { kind: 'mail.account', keyHash: adminKey, accountKey: adminKey, rule: rules.account },
            {
              kind: 'mail.origin',
              keyHash: deps.keys.origin(market, input.origin),
              accountKey: null,
              rule: rules.origin,
            },
          ];
          const reservations = await deps.throttles.reserve(market, counters, now);
          const verdict = reservationVerdict(
            reservations.map((reservation, index) => ({
              reservation,
              rule: counters[index]!.rule,
            })),
            now,
          );
          if (!verdict.allowed) {
            return err({ code: 'request.throttled', retryAfterSeconds: verdict.retryAfterSeconds });
          }
          // R4: the fresh proof, spent here and only here, in the unit of the change.
          const spent = await this.#stepUp.consume(context, CUSTOMER_EMAIL_CHANGE_KEY);
          if (!spent.ok) {
            const refusal = spent.error;
            if (
              refusal.code === 'second-factor.required' ||
              refusal.code === 'second-factor.enrolment-required'
            ) {
              return err({ code: refusal.code, actionKey: refusal.actionKey });
            }
            return err(
              refusal.code === 'access.unavailable'
                ? { code: 'access.unavailable' }
                : { code: 'access.denied' },
            );
          }
          const requested = account.requestEmailChange({ email: email.value, now });
          if (!requested.ok) return err({ code: 'account.not-eligible' });
          await deps.accounts.save(market, account);
          // R2: requested at the same instant as the pending address, in the same unit.
          const found = await deps.links.findFor(market, account.state.id, EMAIL_CHANGE_PURPOSE);
          let link: OneTimeLink;
          if (found === null) {
            link = OneTimeLink.request({
              id: deps.ids.next<'OneTimeLink'>(),
              marketId: market.marketId,
              accountId: account.state.id,
              purpose: EMAIL_CHANGE_PURPOSE,
              now,
              notify: true,
            });
            await deps.links.add(market, link);
          } else {
            link = found;
            link.requestAgain(now, true);
            await deps.links.save(market, link);
          }
          await deps.outbox.append(context, [...account.pendingEvents, ...link.pendingEvents]);
          await deps.audit.record(
            context,
            AccountEmailChangeRequestedAudit.entry(account.state.id, {
              after: { stepUpSessionId: spent.value.sessionId },
            }),
          );
          return ok({ changed: true, requestedAt: now });
        },
      );
    } catch (error) {
      if (error instanceof StaleAggregateError || error instanceof TransactionConflictError) {
        return err({ code: 'access.unavailable' });
      }
      throw error;
    }
  }
}
