import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';

/**
 * How another module tells customers that something of its own still names a manual customer
 * group (customers management phase 2b). Today promotions: a promotion whose customer-group
 * segment (MANUAL_GROUP) names the group and that is live or may become live (active, waiting for
 * approval or paused, and not ended). customers never imports the owner: the owner registers its
 * source here at start (it already depends on customers), so the dependency stays one-way.
 *
 * The answer is advisory: archiving a group is never refused for it. customers puts it on the
 * archive's audit row and in the answer, so the admin sees that a live promotion will stop
 * matching anybody.
 */
export interface CustomerGroupUsageSource {
  /** How many live uses name the group, under the caller's own access check. */
  liveUsesOf(context: CallContext, groupId: string): Promise<Result<number, { code: string }>>;
}

/** What customers knows about a group's live uses when it is archived. */
export type GroupLiveUse = 'none' | 'some' | 'unknown';

/**
 * The single registration point: one source per start. Unbound, or a source that fails or
 * refuses, answers `unknown`, never `none` (a warning that cannot be checked is shown as such).
 */
export class CustomerGroupUsageRegistry implements CustomerGroupUsageSource {
  #source: CustomerGroupUsageSource | null = null;

  register(source: CustomerGroupUsageSource): void {
    if (this.#source !== null) throw new Error('a customer group usage source is registered');
    this.#source = source;
  }

  async liveUsesOf(
    context: CallContext,
    groupId: string,
  ): Promise<Result<number, { code: string }>> {
    if (this.#source === null) return err({ code: 'access.unavailable' });
    try {
      return await this.#source.liveUsesOf(context, groupId);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}

export const CUSTOMER_GROUP_USAGE_REGISTRY = Symbol('CUSTOMER_GROUP_USAGE_REGISTRY');
