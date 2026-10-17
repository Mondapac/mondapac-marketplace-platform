import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_DOCUMENT_VIEW } from '../../contracts/permissions';
import { HistoryViewed, MAX_HISTORY_ROWS_SHOWN } from '../../domain/audit';
import { parseCertificateId } from '../own/own-certificate.shared';
import {
  invalid,
  policyOf,
  reviewerOf,
  reviewFailure,
  type ReviewDependencies,
  type ValidationFailure,
} from '../review/review.shared';

export interface SellerCertificateHistoryReadInput {
  readonly certificateId: unknown;
  /** The id of the oldest row of the previous page; omitted for the newest rows. */
  readonly beforeId?: unknown;
  /** 1 to 100; 50 when omitted. */
  readonly limit?: unknown;
}

export interface HistoryEntryView {
  readonly id: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly submissionId: string | null;
  readonly actorKind: 'seller' | 'admin' | 'system';
  /** The account that made the change; null for the system actor. */
  readonly actorAccountId: string | null;
  readonly reasonCode: string | null;
  /** The Market's plain label of the reason code; null without one or once it left the list. */
  readonly reasonLabel: string | null;
  /** The decrypted note; null without one or when it can no longer be read (erased key). */
  readonly note: string | null;
  readonly occurredAt: string;
}

export interface SellerCertificateHistoryReadOutput {
  readonly certificateId: string;
  readonly sellerId: string;
  /** Newest first. */
  readonly entries: readonly HistoryEntryView[];
  /** The `beforeId` of the next page, or null when no older row exists. */
  readonly nextBeforeId: string | null;
}

export type SellerCertificateHistoryReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'certificate.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const DEFAULT_LIMIT = 50;

/**
 * `seller-certificate.history-read` (certification design 7.2, 11; CERT-17, VER-14, AC 22): the
 * full status history of one seller certificate for an admin, newest first and paged: each change
 * with its from and to status, the submission, who (actor kind and account) and when, the reason
 * code with the Market's label, and the note decrypted under the seller's key outside any unit. One
 * `certification.history.viewed` audit row per read names the rows returned, in its own unit; a
 * refused audit row returns nothing. The route sends `Cache-Control: no-store`. Rule: key
 * `certification.document.view` (protected) and the admin population; without it the read is
 * refused (AC 22).
 */
export class SellerCertificateHistoryRead extends UseCase<
  SellerCertificateHistoryReadInput,
  SellerCertificateHistoryReadOutput,
  SellerCertificateHistoryReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.seller-certificate-history-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_DOCUMENT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: ReviewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: SellerCertificateHistoryReadInput,
  ): Promise<Result<SellerCertificateHistoryReadOutput, SellerCertificateHistoryReadFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const certificateId = parseCertificateId(input.certificateId);
    if (certificateId === null) return invalid('certificateId', 'format');
    let beforeId: Id<'CertificationHistory'> | null = null;
    if (input.beforeId !== undefined && input.beforeId !== null) {
      const parsed =
        typeof input.beforeId === 'string' ? parseId<'CertificationHistory'>(input.beforeId) : null;
      if (parsed === null || !parsed.ok) return invalid('beforeId', 'format');
      beforeId = parsed.value;
    }
    let limit = DEFAULT_LIMIT;
    if (input.limit !== undefined && input.limit !== null) {
      const raw = typeof input.limit === 'string' ? Number(input.limit) : input.limit;
      if (
        typeof raw !== 'number' ||
        !Number.isInteger(raw) ||
        raw < 1 ||
        raw > MAX_HISTORY_ROWS_SHOWN
      ) {
        return invalid('limit', 'range');
      }
      limit = raw;
    }

    const { deps } = this;
    const { market } = context;
    const policy = policyOf(deps, market);
    if (policy === null) return err({ code: 'access.unavailable' });

    const read = await deps.unitOfWork
      .run(
        market,
        async () => ok(await deps.reviews.historyPage(market, certificateId, { beforeId, limit })),
        {
          readOnly: true,
        },
      )
      .catch((error: unknown) => reviewFailure(context, 'certification.history-read', error));
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'certificate.not-found' });
    const page = read.value;

    // Decrypt outside any unit; an unreadable note (an erased key) is shown as none.
    const notes = await Promise.all(
      page.rows.map(async (row) => {
        if (row.noteCiphertext === null) return null;
        try {
          const opened = await deps.cipher.open(
            market,
            page.sellerId,
            'history-note',
            row.noteCiphertext,
          );
          return opened.ok ? opened.value : null;
        } catch {
          return null;
        }
      }),
    );

    const audited = await deps.unitOfWork
      .run(market, async () => {
        await deps.audit.record(
          context,
          HistoryViewed.entry(certificateId, {
            after: { historyIds: page.rows.map((row) => row.id) },
          }),
        );
        return ok(undefined);
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.history-read.audit', error));
    if (!audited.ok) return err({ code: 'access.unavailable' });

    const labelOf = (code: string | null): string | null =>
      code === null ? null : (policy.reasons.find((reason) => reason.code === code)?.label ?? null);
    const last = page.rows[page.rows.length - 1];
    return ok({
      certificateId,
      sellerId: page.sellerId,
      entries: page.rows.map((row, i) => ({
        id: row.id,
        fromStatus: row.fromStatus,
        toStatus: row.toStatus,
        submissionId: row.submissionId,
        actorKind: row.actorKind,
        actorAccountId: row.actorAccountId,
        reasonCode: row.reasonCode,
        reasonLabel: labelOf(row.reasonCode),
        note: notes[i] ?? null,
        occurredAt: row.occurredAt.toString(),
      })),
      nextBeforeId: page.more && last !== undefined ? last.id : null,
    });
  }
}
