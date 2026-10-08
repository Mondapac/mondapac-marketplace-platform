import { Logger } from '@nestjs/common';
import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import {
  StaleAggregateError,
  TransactionConflictError,
} from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { AccountRepository } from '../ports/account.repository';
import type { IdentityMarketPolicy } from '../ports/identity-market-policy';
import type { SellerAccessRepository } from '../ports/seller-access.repository';
import type {
  RoleAssignmentRepository,
  SellerMembershipRepository,
} from '../ports/seller-team.repository';

/** Accounts read per batch; each is deleted in its own unit (C11). */
export const PURGE_BATCH_SIZE = 100;
/** At most this many batches per run; the next daily run continues (P 7: bounded runs). */
export const MAX_PURGE_BATCHES_PER_RUN = 50;

export interface PurgeUnverifiedAccountsOutput {
  readonly deleted: number;
  /** Changed or contended since the batch was read; left for the next run. */
  readonly skipped: number;
}

export type PurgeUnverifiedAccountsFailure = { readonly code: 'access.denied' };

export interface PurgeUnverifiedAccountsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly assignments: RoleAssignmentRepository;
  readonly sellerAccess: SellerAccessRepository;
  readonly policy: IdentityMarketPolicy;
  readonly clock: Clock;
}

/**
 * `identity.purge-unverified-accounts`, daily (identity design 3.1, 12.2; data design 3.3, 9;
 * M5; slice 3). Rule `system`. For one Market: every never-verified account whose latest sign-up
 * is older than the Market's retention (7 days for AU) is erased: its data key destroyed and its
 * row deleted, with its credential, sessions and links (C8), one `serializable` unit per account
 * (C11), so the real owner of the address can always sign up again. Each unit re-reads the
 * account and deletes it only if it is still unverified and still old enough, at the version it
 * read: a sign-up or a confirmation in between wins, and the account is left alone.
 *
 * From slice 5 (data design 9), in the same unit and before the account (the foreign keys are
 * RESTRICT): its role assignment and its memberships; then, after the account, each seller of
 * those memberships that was never registered (`seller-registered` not recorded) and has no
 * member left, with its data key destroyed. A registered seller is never deleted here.
 *
 * Deletes only what is already invalid; safe to run twice and concurrently (PN4). Logs ids and
 * counts only.
 */
export class PurgeUnverifiedAccounts extends UseCase<
  Record<string, never>,
  PurgeUnverifiedAccountsOutput,
  PurgeUnverifiedAccountsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'identity.purge-unverified-accounts',
    rule: { kind: 'system' },
  };

  readonly #logger = new Logger('PurgeUnverifiedAccounts');

  constructor(
    gate: UseCaseGate,
    private readonly deps: PurgeUnverifiedAccountsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<PurgeUnverifiedAccountsOutput, PurgeUnverifiedAccountsFailure>> {
    const { market } = context;
    if (context.actor.kind !== 'system') return err({ code: 'access.denied' });
    const { unitOfWork, accounts, policy, clock } = this.deps;
    const cutoff = clock
      .now()
      .subtract({ hours: policy.unverifiedAccountRetentionDays(market) * 24 });

    let deleted = 0;
    let skipped = 0;
    const seen = new Set<string>();
    for (let batch = 0; batch < MAX_PURGE_BATCHES_PER_RUN; batch += 1) {
      const listed = await unitOfWork.run(
        market,
        async () => ok(await accounts.unverifiedSignedUpBefore(market, cutoff, PURGE_BATCH_SIZE)),
        { readOnly: true },
      );
      const ids = listed.ok ? listed.value.filter((id) => !seen.has(id)) : [];
      if (ids.length === 0) break;
      for (const id of ids) {
        seen.add(id);
        try {
          const removed = await unitOfWork.run(
            market,
            async () => {
              const account = await accounts.findById(market, id);
              if (
                account === null ||
                account.isEmailVerified ||
                Temporal.Instant.compare(account.state.signedUpAt, cutoff) >= 0
              ) {
                return ok(false);
              }
              const { memberships, assignments, sellerAccess } = this.deps;
              const assignment = await assignments.findByAccount(market, id);
              if (assignment !== null) await assignments.remove(market, assignment);
              const sellerIds = [];
              for (const membership of await memberships.findAllByAccount(market, id)) {
                await memberships.remove(market, membership);
                sellerIds.push(membership.state.sellerId);
              }
              await accounts.remove(market, account);
              for (const sellerId of sellerIds) {
                const access = await sellerAccess.findById(market, sellerId);
                if (
                  access !== null &&
                  !access.isRegistered &&
                  !(await memberships.sellerHasMembers(market, sellerId))
                ) {
                  await sellerAccess.removeUnregistered(market, access);
                }
              }
              return ok(true);
            },
            { isolation: 'serializable' },
          );
          if (removed.ok && removed.value) deleted += 1;
          else skipped += 1;
        } catch (error) {
          if (!(
            error instanceof StaleAggregateError || error instanceof TransactionConflictError
          )) {
            throw error;
          }
          skipped += 1;
          this.#logger.warn({
            msg: 'identity.purge-unverified-accounts.contended',
            accountId: id,
            marketId: market.marketId,
            correlationId: context.correlationId,
          });
        }
      }
      if (ids.length < PURGE_BATCH_SIZE) break;
    }
    return ok({ deleted, skipped });
  }
}
