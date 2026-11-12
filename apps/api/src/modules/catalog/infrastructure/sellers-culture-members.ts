import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { SellersFacade } from '../../sellers';
import type {
  CultureMembers,
  CultureMembersUnavailable,
} from '../application/ports/culture-members';

const UNAVAILABLE = err({ code: 'culture-members.unavailable' } as const);

/** {@link CultureMembers} over `sellers.cultureHasApprovedMembers`; anything but a boolean is unavailable. */
export class SellersCultureMembers implements CultureMembers {
  constructor(private readonly sellers: SellersFacade) {}

  async hasApproved(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<Result<boolean, CultureMembersUnavailable>> {
    try {
      const answer = await this.sellers.cultureHasApprovedMembers(context, cultureId);
      return answer.ok && typeof answer.value === 'boolean' ? ok(answer.value) : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }

  async demoteAll(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<Result<boolean, CultureMembersUnavailable>> {
    try {
      const done = await this.sellers.cultureDemoteApprovals(context, cultureId);
      return done.ok && typeof done.value?.remaining === 'boolean'
        ? ok(!done.value.remaining)
        : UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}
