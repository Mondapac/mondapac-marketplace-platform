import type { CallContext, Clock } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { withdrawn } from '../../domain/business-file-revision';
import type { SellerFile } from '../../domain/seller-file';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';

export interface WithdrawOnEditDependencies {
  readonly revisions: BusinessFileRevisionRepository;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
}

/**
 * What an edit did to the file's submission: `none` (no pending revision), `withdrawn` (the
 * pending revision was withdrawn), or `lost` (it was no longer pending when the write ran, so a
 * decision or another withdrawal got there first: the caller refuses with `conflict.stale` and
 * the unit rolls back, writing nothing).
 */
export type WithdrawOnEditOutcome = 'none' | 'withdrawn' | 'lost';

/**
 * An edit of the draft withdraws the pending submission (sellers design 3.1, brief s5: approval
 * is bound to what was reviewed; the page warns first, ux F14). Called by every draft save,
 * inside its read-write unit, **after** the draft write succeeded: the write is a version
 * compare-and-set on the file row, and a submission that committed first is visible to the read
 * here (READ COMMITTED), while one that commits later finds the version raised and loses. The
 * revision is closed with one `UPDATE … WHERE status = 'pending'` and its row count checked; the
 * file records `sellers.business-file-withdrawn.v1` at the version the edit already raised.
 *
 * A save that changed nothing (version not raised) never calls it. Any save that raises the
 * version counts as an edit: sealed fields get a new ciphertext on each save, so "same value" is
 * not decidable here; the client sends no save for an unchanged page (ux F14 step 2).
 */
export async function withdrawPendingOnEdit(
  deps: WithdrawOnEditDependencies,
  context: CallContext,
  file: SellerFile,
): Promise<WithdrawOnEditOutcome> {
  const { market } = context;
  const pending = await deps.revisions.findPending(market, file.state.sellerId);
  if (pending === null) return 'none';
  const now = deps.clock.now();
  const closed = withdrawn(pending, 'edited', 'seller', now);
  if (!closed.ok) return 'lost';
  if (!(await deps.revisions.saveWithdrawal(market, closed.value))) return 'lost';
  file.recordWithdrawal({ revisionId: pending.id, cause: 'edited', byKind: 'seller' }, now);
  await deps.outbox.append(context, file.pendingEvents);
  return 'withdrawn';
}
