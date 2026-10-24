import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * Who a current member of the seller's own team is, as a history row names them (seller
 * operations P-E): the display name and the role label. PERSONAL DATA for the member who asked:
 * never logged, cached, or put in an event, an audit row or an error body.
 */
export interface TeamMemberLabel {
  readonly displayName: string | null;
  /** `seedCode` labels a seeded role, `name` a custom one; null without a visible role. */
  readonly role: {
    readonly kind: 'system' | 'default' | 'custom';
    readonly seedCode: string | null;
    readonly name: string | null;
  } | null;
}

/**
 * `identity`'s answer, with the caller's `CallContext` unchanged, outside any unit of work: the
 * accounts of `accountIds` that are current members of the actor's own team. An absent id is a
 * former member (or never one). It throws {@link SellerAccountAccessRefused} when `identity`
 * refuses the actor, and another error when it cannot answer.
 */
export interface TeamMemberLabelSource {
  labelsOf(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, TeamMemberLabel>>;
}

export const TEAM_MEMBER_LABEL_SOURCE = Symbol('TEAM_MEMBER_LABEL_SOURCE');
