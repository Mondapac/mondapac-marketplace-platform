import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_APPROVE } from '../../contracts/permissions';
import { OFFER_CHANGE_REASONS, PRODUCT_CHANGE_REASONS } from '../../domain/events';
import { BULK_DECIDE_MAX, parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { BulkDecideItem, BulkDecideResult } from '../lists/bulk-decide';
import { bulkOfferApprovalVerdicts, type BulkOfferVerdict } from '../lists/offer-bulk-approval';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferReviewQueueFacts } from '../ports/offer-review';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
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
  readonly unitOfWork: UnitOfWork;
  readonly offers: OfferRepository;
  readonly queueFacts: OfferReviewQueueFacts;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
}

/** What a bulk decision of Offers reads first: each row's label and its bulk approval verdict. */
interface OfferRowFacts {
  readonly names: ReadonlyMap<string, string | null>;
  readonly verdicts: ReadonlyMap<string, BulkOfferVerdict>;
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
 *
 * Offers (risk-based Offer approval slice 5, Hadi's decision 3): a bulk approve clears only R1
 * `probation`, R6 `full-review` and R2 `certificate-badge` when every R2 row is one seller's and
 * asks one certificate type (`bulkOfferApprovalVerdicts`, from the Offer's latest first-publication
 * referral and its open tags, read in one read-only unit first). Any other row is skipped with
 * `review.bulk-not-allowed` and its `blockers` (R0, R3, R5, R7, review-all), or
 * `review.bulk-certificate-mixed`, or `review.reasons-unknown` (no stored decision: fail closed);
 * the rest goes on. Offer rows carry the product `name` in the result. A bulk request changes
 * sends every row back with the one prepared reason code.
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
    let offerFacts: OfferRowFacts | null = null;
    if (kind === 'offer') {
      const read = await this.#offerFacts(context, items);
      // The allow-list of a bulk approval is never skipped: unreadable reasons refuse the request.
      // A send-back needs the facts for the row names only, so it goes on without them.
      if (read.ok) offerFacts = read.value;
      else if (action === 'approve') return read;
    }
    const done = await runBulkDecide(items, (item) => {
      if (kind === 'offer') {
        const verdict = offerFacts?.verdicts.get(item.id.toLowerCase());
        if (action === 'approve' && verdict !== undefined && !verdict.allowed) {
          return Promise.resolve(err({ code: verdict.reason }));
        }
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
    if (kind !== 'offer') return ok({ action, ...done });
    const facts = offerFacts;
    const results = done.results.map((result): BulkDecideResult => {
      const key = result.id.toLowerCase();
      const verdict = facts?.verdicts.get(key);
      return {
        ...result,
        name: facts?.names.get(key) ?? null,
        ...(action === 'approve' &&
        verdict !== undefined &&
        !verdict.allowed &&
        result.reason === verdict.reason
          ? { blockers: verdict.blockers }
          : {}),
      };
    });
    return ok({ action, counts: done.counts, results });
  }

  /**
   * The label of each Offer row and its bulk approval verdict, in one read-only unit. An unknown
   * Offer has neither: its single decision answers `offer.not-found` (skipped). A failed read is
   * `access.unavailable`: the caller refuses an approval and sends rows back without names.
   */
  async #offerFacts(
    context: CallContext,
    items: readonly BulkDecideItem[],
  ): Promise<Result<OfferRowFacts, BulkDecideRefusal>> {
    const { market } = context;
    const ids = items.flatMap((item) => {
      const parsed = parseId<'Offer'>(item.id.toLowerCase());
      return parsed.ok ? [parsed.value] : [];
    });
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    try {
      const read = await this.deps.unitOfWork.run(
        market,
        async () => {
          const offers = await this.deps.offers.findManyByIds(market, ids);
          const found = offers.map((offer) => offer.state.id);
          const reasons = await this.deps.queueFacts.firstPublicationReasons(market, found);
          const tagTypes = await this.deps.queueFacts.openTagTypes(market, found);
          const productIds = [...new Set(offers.map((offer) => offer.state.productId))];
          const labels =
            productIds.length === 0
              ? []
              : await this.deps.ownReader.productLabels(market, productIds, locale);
          return ok({ offers, reasons, tagTypes, labels });
        },
        { readOnly: true },
      );
      if (!read.ok) return err({ code: 'access.unavailable' });
      const { offers, reasons, tagTypes, labels } = read.value;
      const nameOf = new Map(labels.map((label) => [label.productId as string, label.name]));
      const verdicts = bulkOfferApprovalVerdicts(
        offers.map((offer) => ({
          offerId: offer.state.id,
          sellerId: offer.state.sellerId,
          reasons: reasons.get(offer.state.id) ?? null,
          tagTypes: tagTypes.get(offer.state.id) ?? [],
        })),
      );
      return ok({
        names: new Map(
          offers.map((offer) => [offer.state.id, nameOf.get(offer.state.productId) ?? null]),
        ),
        verdicts,
      });
    } catch {
      return err({ code: 'access.unavailable' });
    }
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
