import { Logger } from '@nestjs/common';
import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { EffectiveKeyResolver } from '../access/effective-keys';
import type { AccountRepository } from '../ports/account.repository';
import type { RoleGrantReader } from '../ports/role-grant-reader';
import type { SellerMembershipRepository } from '../ports/seller-team.repository';
import { readActingGrants, type GrantSubject } from '../roles/granting';

/** The most ids one call may name: one page of a settings history. */
export const MAX_CHANGE_ACTOR_IDS = 100;

export interface ChangeActorLabelsInput {
  /** As the caller passed them; parsed here, and never echoed when one does not parse. */
  readonly accountIds: readonly string[];
}

/**
 * Who made a change, as the asking side may see it: `member` is a person of the asker's own side
 * (an admin for an admin, a current member of the shop's team for a seller) with their display
 * name; `platform` is Mondapac staff seen by a seller, never named. PERSONAL DATA: never logged,
 * stored, cached or put in an event, an audit row or an error body.
 */
export interface ChangeActorLabelView {
  readonly accountId: Id<'Account'>;
  readonly kind: 'member' | 'platform';
  readonly displayName: string | null;
}

export type ChangeActorLabelsFailure =
  | { readonly code: 'access.denied' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface ChangeActorLabelsDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly accounts: AccountRepository;
  readonly memberships: SellerMembershipRepository;
  readonly grants: RoleGrantReader;
  readonly effectiveKeys: EffectiveKeyResolver;
}

const USE_CASE = 'identity.change-actor-labels';

/**
 * `changeActors` (the "last changed by" line and history of every settings page): names the
 * accounts that audit rows record as the actor of a settings change, for the side that asks.
 * Rule `own-resources`, denied while a seller is not approved: any signed-in admin may see which
 * admin changed an admin setting they can read, and any active member of a shop which member
 * changed the shop's settings. The answer is the display name only, never the sign-in address:
 *
 * - an admin asks: an account of the admin population in this Market is `member` with its name;
 *   any other account (a seller, a customer, an unknown id) is absent, exactly alike;
 * - a seller asks: a current member of the actor's own shop is `member` with its name; an admin
 *   account is `platform` with no name (PA 10, Hassan I4: no admin id or name reaches a seller);
 *   a former member, another seller's member, a customer and an unknown id are absent, alike.
 *
 * The actor is read again in this unit (an active, verified account of its population) before any
 * other account. Refused with `access.denied`: a customer, the system actor (by the gate). Never
 * over HTTP. Up to 100 ids, duplicates answered once; a malformed id is skipped (counted in the
 * log, never echoed). One read-only unit, no audit row (the page's setting is not personal data
 * and the name is the one its own page already shows). The log line carries counts, never a name.
 */
export class ChangeActorLabels extends UseCase<
  ChangeActorLabelsInput,
  readonly ChangeActorLabelView[],
  ChangeActorLabelsFailure
> {
  static override readonly access: AccessDeclaration = {
    name: USE_CASE,
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  readonly #logger = new Logger('ChangeActorLabels');

  constructor(
    gate: UseCaseGate,
    private readonly deps: ChangeActorLabelsDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: ChangeActorLabelsInput,
  ): Promise<Result<readonly ChangeActorLabelView[], ChangeActorLabelsFailure>> {
    const { actor, market } = context;
    let skipped = 0;
    const result = await this.read(context, input, () => (skipped += 1));
    this.#logger.log({
      msg: USE_CASE,
      outcome: result.ok ? 'change-actor-labels.read' : result.error.code,
      ...(result.ok ? { rows: result.value.length } : {}),
      ...(skipped > 0 ? { malformedIds: skipped } : {}),
      ...(actor.kind === 'authenticated' ? { accountId: actor.accountId } : {}),
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  private async read(
    context: CallContext,
    input: ChangeActorLabelsInput,
    skip: () => void,
  ): Promise<Result<readonly ChangeActorLabelView[], ChangeActorLabelsFailure>> {
    const { market, actor } = context;
    if (actor.kind !== 'authenticated') return err({ code: 'access.denied' });
    const viewer = actor.population;
    if (viewer === 'seller' ? actor.sellerId === null : viewer !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const raw = input?.accountIds as unknown;
    if (!Array.isArray(raw) || raw.length > MAX_CHANGE_ACTOR_IDS) {
      return err({ code: 'validation.failed', fields: [{ path: 'accountIds', code: 'length' }] });
    }
    const ids = new Set<Id<'Account'>>();
    for (const value of raw as readonly unknown[]) {
      const parsed = typeof value === 'string' ? parseId<'Account'>(value) : null;
      if (parsed === null || !parsed.ok) skip();
      else ids.add(parsed.value);
    }
    if (ids.size === 0) return ok([]);
    const sellerId = viewer === 'seller' ? actor.sellerId : null;
    const self: GrantSubject = { accountId: actor.accountId, population: viewer, sellerId };
    return this.deps.unitOfWork.run(
      market,
      async (): Promise<Result<readonly ChangeActorLabelView[], ChangeActorLabelsFailure>> => {
        // The actor again, in this read, before any other account is loaded (Hassan L1).
        if ((await readActingGrants(this.deps, market, self, [], [])) === null) {
          return err({ code: 'access.denied' });
        }
        if (sellerId !== null) {
          const own = await this.deps.memberships.findActiveByAccount(market, actor.accountId);
          if (own === null || own.state.sellerId !== sellerId) {
            return err({ code: 'access.denied' });
          }
        }
        const labels: ChangeActorLabelView[] = [];
        for (const accountId of ids) {
          const account = await this.deps.accounts.findById(market, accountId);
          if (account === null) continue;
          if (viewer === 'admin') {
            if (account.state.population === 'admin') {
              labels.push({ accountId, kind: 'member', displayName: account.state.displayName });
            }
            continue;
          }
          if (account.state.population === 'admin') {
            labels.push({ accountId, kind: 'platform', displayName: null });
            continue;
          }
          if (account.state.population !== 'seller') continue;
          const membership = await this.deps.memberships.findActiveByAccount(market, accountId);
          if (membership !== null && membership.state.sellerId === sellerId) {
            labels.push({ accountId, kind: 'member', displayName: account.state.displayName });
          }
        }
        return ok(labels);
      },
      { readOnly: true },
    );
  }
}
