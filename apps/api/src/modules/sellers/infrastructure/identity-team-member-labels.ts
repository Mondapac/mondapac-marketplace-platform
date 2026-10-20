import type { CallContext, Id } from '@mondapac/shared-kernel';
import type { IdentityFacade } from '../../identity/contracts/identity.facade';
import { SellerAccountAccessRefused } from '../application/ports/seller-account-directory';
import type {
  TeamMemberLabel,
  TeamMemberLabelSource,
} from '../application/ports/team-member-labels';

/**
 * {@link TeamMemberLabelSource} on `identity`'s facade (`teamMemberLabels`). Its refusal of the
 * actor throws {@link SellerAccountAccessRefused}; any other refusal throws, so the caller fails
 * closed and never shows a guess.
 */
export class IdentityTeamMemberLabels implements TeamMemberLabelSource {
  constructor(private readonly identity: IdentityFacade) {}

  async labelsOf(
    context: CallContext,
    accountIds: readonly Id<'Account'>[],
  ): Promise<ReadonlyMap<Id<'Account'>, TeamMemberLabel>> {
    if (accountIds.length === 0) return new Map();
    const result = await this.identity.teamMemberLabels(context, accountIds);
    if (!result.ok) {
      if (result.error.code === 'access.denied') {
        throw new SellerAccountAccessRefused('identity.teamMemberLabels: access.denied');
      }
      throw new Error(`identity.teamMemberLabels refused: ${result.error.code}`);
    }
    return new Map(
      result.value.map((row) => [row.accountId, { displayName: row.displayName, role: row.role }]),
    );
  }
}
