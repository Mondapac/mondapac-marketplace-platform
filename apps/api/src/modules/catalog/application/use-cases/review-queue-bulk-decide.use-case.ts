import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OFFER_CHANGE_REASONS, PRODUCT_CHANGE_REASONS } from '../../domain/events';
import { BULK_DECIDE_MAX, parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { BulkDecideItem } from '../lists/bulk-decide';
import {
  adminOnly,
  closed,
  refuse,
  type BulkDecideOutput,
  type BulkDecideRefusal,
} from '../lists/bulk-decide-shared';
import type { OfferApprove } from './offer-approve.use-case';
import type { OfferRequestChanges } from './offer-request-changes.use-case';
import type { ProductRevisionApprove } from './product-revision-approve.use-case';
import type { ProductRevisionRequestChanges } from './product-revision-request-changes.use-case';

export interface ReviewQueueBulkDecideDependencies {
  readonly revisionApprove: ProductRevisionApprove;
  readonly revisionRequestChanges: ProductRevisionRequestChanges;
  readonly offerApprove: OfferApprove;
  readonly offerRequestChanges: OfferRequestChanges;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `review-queue.bulk-decide` (super list 13): approve, or request changes with one reason code, up
 * to 50 rows of the review queue. `kind` is `revision` (a pending product revision; each item is
 * `{ id: productId, revisionId, version }`) or `offer` (each item is `{ id: offerId, version }`).
 *
 * Owner decision (john, 20 Nov 2026): a bulk approve never ticks a manual check. A revision whose
 * review needs checks (design 8.3a) is skipped with `review.checks-missing` and reported, so a
 * person opens it and ticks the checks; the rest of the batch goes on. Each row runs the single
 * use case as the caller (own unit, own audit row, own key check).
 */
export class ReviewQueueBulkDecide extends UseCase<unknown, BulkDecideOutput, BulkDecideRefusal> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.review-queue-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_APPROVE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewQueueBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['kind', 'action', 'reasonCode', 'items']);
    if (!body.ok) return body;
    const kind = body.value['kind'];
    if (kind !== 'revision' && kind !== 'offer') return refuse('kind', 'value');
    const action = body.value['action'];
    if (action !== 'approve' && action !== 'request-changes') return refuse('action', 'value');
    const reasonCode = body.value['reasonCode'];
    if (action === 'approve') {
      if (reasonCode !== undefined) return refuse('reasonCode', 'unknown');
    } else {
      const reasons: readonly string[] =
        kind === 'revision' ? PRODUCT_CHANGE_REASONS : OFFER_CHANGE_REASONS;
      if (typeof reasonCode !== 'string' || !reasons.includes(reasonCode)) {
        return refuse('reasonCode', 'unknown');
      }
    }
    let items: readonly BulkDecideItem[];
    let revisionOf: ReadonlyMap<string, string> = new Map();
    if (kind === 'offer') {
      const parsed = parseBulkItems(body.value['items']);
      if (!parsed.ok) return parsed;
      items = parsed.value;
    } else {
      const parsed = parseRevisions(body.value['items']);
      if (!parsed.ok) return parsed;
      ({ items, revisionOf } = parsed.value);
    }
    const reason = typeof reasonCode === 'string' ? reasonCode : '';
    const done = await runBulkDecide(items, (item) => {
      if (kind === 'offer') {
        return action === 'approve'
          ? this.deps.offerApprove.execute(context, { offerId: item.id, version: item.version })
          : this.deps.offerRequestChanges.execute(context, {
              offerId: item.id,
              version: item.version,
              reasonCode: reason,
            });
      }
      const revisionId = revisionOf.get(item.id.toLowerCase()) ?? '';
      return action === 'approve'
        ? this.deps.revisionApprove.execute(context, {
            productId: item.id,
            revisionId,
            version: item.version,
            checksConfirmed: [],
          })
        : this.deps.revisionRequestChanges.execute(context, {
            productId: item.id,
            revisionId,
            version: item.version,
            reasonCode: reason,
          });
    });
    return ok({ action, ...done });
  }
}

type Parsed = {
  readonly items: readonly BulkDecideItem[];
  readonly revisionOf: ReadonlyMap<string, string>;
};

function parseRevisions(raw: unknown): Result<Parsed, BulkDecideRefusal> {
  if (!Array.isArray(raw)) return refuse('items', 'type');
  if (raw.length === 0) return refuse('items', 'required');
  if (raw.length > BULK_DECIDE_MAX) return err({ code: 'batch.too-large', max: BULK_DECIDE_MAX });
  const items: BulkDecideItem[] = [];
  const revisionOf = new Map<string, string>();
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return refuse(`items.${index}`, 'type');
    }
    const record = entry as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== 'id' && key !== 'revisionId' && key !== 'version') {
        return refuse(`items.${index}.${key}`, 'unknown');
      }
    }
    const { id, revisionId, version } = record;
    if (typeof id !== 'string' || !UUID.test(id)) return refuse(`items.${index}.id`, 'format');
    if (typeof revisionId !== 'string' || !UUID.test(revisionId)) {
      return refuse(`items.${index}.revisionId`, 'format');
    }
    if (
      typeof version !== 'number' ||
      !Number.isInteger(version) ||
      version < 1 ||
      version > 2147483647
    ) {
      return refuse(`items.${index}.version`, 'type');
    }
    if (revisionOf.has(id.toLowerCase())) return refuse(`items.${index}.id`, 'duplicate');
    revisionOf.set(id.toLowerCase(), revisionId);
    items.push({ id, version });
  }
  return ok({ items, revisionOf });
}
