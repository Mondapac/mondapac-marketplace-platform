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
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { Account } from '../../domain/account';
import { openSession } from '../../domain/session';
import type { AccountRepository } from '../ports/account.repository';
import type { ExternalIdentityRepository } from '../ports/external-identity.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { PasswordHasher } from '../ports/password-hasher';
import type { SessionRepository } from '../ports/session.repository';
import type { SessionTokens } from '../ports/session-secrets';
import type { SignInProviderFlowSecrets, SignInProviders } from '../ports/sign-in-providers';
import type { SignInRecord, SignInRecordRepository } from '../ports/sign-in-record.repository';
import {
  verifyProviderCallback,
  type ProviderCallbackFailure,
  type ProviderCallbackInput,
  type VerifiedProviderIdentity,
} from '../social/provider-callback';
import type { SignInClient } from './sign-in-customer.use-case';
import type { SecurityEvents } from '../../../../platform/security-events/security-events';
import { recordSignInSecurityEvent } from '../security-events';

export interface SignInWithProviderInput extends ProviderCallbackInput {
  readonly client: SignInClient;
}

/** A new customer session. The token goes into the cookie only, never a body or a log. */
export interface SignInWithProviderOutput {
  readonly code: 'signed-in';
  readonly token: string;
  readonly absoluteLifetimeSeconds: number;
  /** Whether this sign-in created the account. */
  readonly created: boolean;
}

export type SignInWithProviderFailure =
  | ProviderCallbackFailure
  /**
   * A customer account already holds the email and is not connected to this provider identity:
   * never connected automatically. The holder signs in with the password and connects it.
   */
  | { readonly code: 'link-required' }
  | { readonly code: 'account.disabled' }
  | { readonly code: 'request.busy' }
  | { readonly code: 'access.unavailable' };

export interface SignInWithProviderDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly externalIdentities: ExternalIdentityRepository;
  readonly sessions: SessionRepository;
  readonly records: SignInRecordRepository;
  readonly securityEvents: SecurityEvents;
  readonly hasher: PasswordHasher;
  readonly tokens: SessionTokens;
  readonly outbox: OutboxWriter;
  readonly signInProviders: SignInProviders;
  readonly flowSecrets: SignInProviderFlowSecrets;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

type Decided =
  | { readonly kind: 'signed-in'; readonly sessionToken: string }
  | { readonly kind: 'create' }
  | { readonly kind: 'refused'; readonly code: 'link-required' | 'account.disabled' };

const UNAVAILABLE = Object.freeze({ code: 'access.unavailable' as const });

/**
 * A customer's sign-in, or sign-up, through a sign-in provider (social sign-in; rule `anonymous`,
 * the caller has no session yet). After {@link verifyProviderCallback}:
 *
 * 1. One READ COMMITTED unit reads the provider identity by (Market, provider, subject). Known:
 *    its account signs in (a disabled account answers `account.disabled`). Unknown: a customer
 *    account that holds the email answers `link-required`; it is never connected automatically,
 *    verified or not (an unverified holder can still prove the mailbox with the reset link).
 * 2. Only when no account holds the email, a throwaway password nobody holds is hashed outside
 *    any unit, then one serializable unit (HF8: it inserts into `accounts`) checks both again and
 *    creates a verified customer account, its provider identity and a session. A concurrent
 *    sign-up of the same person loses on a unique key and answers `access.unavailable`; the next
 *    attempt signs in.
 *
 * Every outcome writes one sign-in record (never the email or the subject). The session is the
 * customer session of the password sign-in: the same lifetimes, cookie and CSRF token.
 */
export class SignInWithProvider extends UseCase<
  SignInWithProviderInput,
  SignInWithProviderOutput,
  SignInWithProviderFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.sign-in-with-provider',
    rule: { kind: 'anonymous' },
  };

  readonly #logger = new Logger('SignInWithProvider');

  constructor(
    gate: UseCaseGate,
    private readonly deps: SignInWithProviderDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SignInWithProviderInput,
  ): Promise<Result<SignInWithProviderOutput, SignInWithProviderFailure>> {
    const { market } = context;
    const { unitOfWork, accounts, externalIdentities, policy, hasher, tokens } = this.deps;
    const lifetime = policy.sessionLifetime(market, 'customer');
    if (lifetime === null) return err(UNAVAILABLE);
    const verified = await verifyProviderCallback(
      market,
      'sign-in',
      input,
      this.deps.signInProviders,
      this.deps.flowSecrets,
    );
    if (!verified.ok) return err(verified.error);
    const person = verified.value;
    const signedIn = (sessionToken: string, created: boolean) =>
      ok({
        code: 'signed-in' as const,
        token: sessionToken,
        absoluteLifetimeSeconds: lifetime.absoluteLifetimeSeconds,
        created,
      });

    let decided: Decided;
    try {
      const run = await unitOfWork.run(market, async (): Promise<Result<Decided, never>> => {
        const now = this.deps.clock.now();
        const known = await externalIdentities.findBySubject(
          market,
          input.provider,
          person.subject,
        );
        if (known !== null) return ok(await this.openFor(context, known.accountId, input, now));
        const holder = await accounts.findByEmail(market, 'customer', person.email.normalized);
        if (holder === null) return ok({ kind: 'create' });
        await this.record(context, input, holder.state.id, 'link-required', null, now);
        return ok({ kind: 'refused', code: 'link-required' });
      });
      if (!run.ok) return err(UNAVAILABLE);
      decided = run.value;
    } catch {
      return this.unavailable(context, 'read');
    }
    if (decided.kind === 'signed-in') return signedIn(decided.sessionToken, false);
    if (decided.kind === 'refused') return err({ code: decided.code });

    // HF12: the throwaway password is hashed outside every unit.
    const hashed = await hasher.hash(tokens.issue().token);
    if (!hashed.ok) return err({ code: 'request.busy' });
    try {
      const run = await unitOfWork.run(
        market,
        async (): Promise<Result<Decided, never>> => {
          const now = this.deps.clock.now();
          const known = await externalIdentities.findBySubject(
            market,
            input.provider,
            person.subject,
          );
          if (known !== null) return ok(await this.openFor(context, known.accountId, input, now));
          if ((await accounts.findByEmail(market, 'customer', person.email.normalized)) !== null) {
            await this.record(context, input, null, 'link-required', null, now);
            return ok({ kind: 'refused', code: 'link-required' });
          }
          return ok(await this.create(context, input, person, hashed.value, now));
        },
        { isolation: 'serializable' },
      );
      if (!run.ok) return err(UNAVAILABLE);
      decided = run.value;
    } catch {
      return this.unavailable(context, 'create');
    }
    if (decided.kind === 'signed-in') return signedIn(decided.sessionToken, true);
    if (decided.kind === 'refused') return err({ code: decided.code });
    return err(UNAVAILABLE);
  }

  /** Inside a unit: the known account's session, or its refusal. */
  private async openFor(
    context: CallContext,
    accountId: Id<'Account'>,
    input: SignInWithProviderInput,
    now: Temporal.Instant,
  ): Promise<Decided> {
    const account = await this.deps.accounts.findById(context.market, accountId);
    if (account === null || account.state.population !== 'customer') {
      throw new Error('SignInWithProvider: a provider identity without its customer account');
    }
    if (account.state.status !== 'active') {
      await this.record(context, input, accountId, 'account.disabled', null, now);
      return { kind: 'refused', code: 'account.disabled' };
    }
    return {
      kind: 'signed-in',
      sessionToken: await this.openSession(context, input, accountId, now),
    };
  }

  /** Inside the serializable unit: the new account, its provider identity and a session. */
  private async create(
    context: CallContext,
    input: SignInWithProviderInput,
    person: VerifiedProviderIdentity,
    passwordHash: string,
    now: Temporal.Instant,
  ): Promise<Decided> {
    const { market } = context;
    const account = Account.registerCustomerWithProvider({
      id: this.deps.ids.next<'Account'>(),
      marketId: market.marketId,
      email: person.email,
      passwordHash,
      now,
    });
    const added = await this.deps.accounts.add(market, account);
    if (!added.ok) throw new Error(`SignInWithProvider: ${added.error.code}`);
    const linked = await this.deps.externalIdentities.add(market, {
      accountId: account.state.id,
      provider: input.provider,
      subject: person.subject,
      createdAt: now,
    });
    if (!linked.ok) throw new Error(`SignInWithProvider: ${linked.error.code}`);
    await this.deps.outbox.append(context, [...account.pendingEvents]);
    return {
      kind: 'signed-in',
      sessionToken: await this.openSession(context, input, account.state.id, now),
    };
  }

  private async openSession(
    context: CallContext,
    input: SignInWithProviderInput,
    accountId: Id<'Account'>,
    now: Temporal.Instant,
  ): Promise<string> {
    const { market } = context;
    const lifetime = this.deps.policy.sessionLifetime(market, 'customer');
    if (lifetime === null) throw new Error('SignInWithProvider: no customer session lifetime');
    const issued = this.deps.tokens.issue();
    const session = openSession({
      id: this.deps.ids.next<'Session'>(),
      marketId: market.marketId,
      accountId,
      population: 'customer',
      transport: 'cookie',
      device: input.client.device ?? null,
      lifetime,
      now,
    });
    await this.deps.sessions.add(market, session, issued.tokenHash);
    await this.record(context, input, accountId, 'signed-in', session.id, now);
    return issued.token;
  }

  private unavailable(
    context: CallContext,
    unit: 'read' | 'create',
  ): Result<never, SignInWithProviderFailure> {
    this.#logger.warn({
      msg: 'identity.sign-in-with-provider.unit-unavailable',
      unit,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return err(UNAVAILABLE);
  }

  /** One sign-in record (identity design 10.2): never the email, the subject or a token. */
  private async record(
    context: CallContext,
    input: SignInWithProviderInput,
    accountId: Id<'Account'> | null,
    outcome: string,
    sessionId: Id<'Session'> | null,
    now: Temporal.Instant,
  ): Promise<void> {
    const record: SignInRecord = {
      id: this.deps.ids.next<'SignInRecord'>(),
      population: 'customer',
      accountId,
      // A success is `signed-in`, as for a password, so it counts as the last sign-in (8.6).
      outcome: outcome === 'signed-in' ? outcome : `provider.${outcome}`,
      occurredAt: now,
      address: input.client.address,
      sessionId,
      correlationId: context.correlationId,
    };
    await this.deps.records.add(context.market, record);
    await recordSignInSecurityEvent(this.deps.securityEvents, context, record);
  }
}
