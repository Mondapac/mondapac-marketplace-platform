import type { CallContext } from '@mondapac/shared-kernel';
import { derivedId } from '../../../../platform/hashing/derived-id';
import { SellerCultureStatusChanged } from '../../domain/events';
import type { SellerCultureState } from '../../domain/seller-culture';
import type { CultureInfo } from '../ports/culture-directory';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';

/** How the certificate of a culture with a required type stands, for the reviewer's list. */
export type CertificateState = 'not-required' | 'held' | 'missing' | 'unavailable';

/** One membership as the routes show it. */
export interface SellerCultureView {
  readonly cultureId: string;
  readonly cultureCode: string;
  /** Name by locale; empty when the culture can no longer be read. */
  readonly names: Readonly<Record<string, string>>;
  readonly cultureStatus: 'draft' | 'active' | 'inactive' | 'unknown';
  /** The certification type a member must hold a valid certificate of, or null. */
  readonly requiredCertificationType: string | null;
  readonly status: SellerCultureState['status'];
  /** The reviewer's reason (always set on a rejection). */
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  /**
   * True while the request waits and the culture needs a certificate: the screen shows "Needs a
   * valid <certificate> certificate". For a reviewer it is true only when the seller holds none.
   */
  readonly needsCertificate: boolean;
  /** Reviewer lists only; the seller's own list cannot read certificates. */
  readonly certificate?: CertificateState;
  readonly version: number;
}

export function viewOf(
  state: SellerCultureState,
  culture: CultureInfo | undefined,
  certificate?: CertificateState,
): SellerCultureView {
  const required = culture?.requiredCertificationType ?? null;
  const waiting = state.status === 'requested' && required !== null;
  return {
    cultureId: state.cultureId,
    cultureCode: state.cultureCode,
    names: culture?.names ?? {},
    cultureStatus: culture?.status ?? 'unknown',
    requiredCertificationType: required,
    status: state.status,
    reason: state.reason,
    requestedAt: state.requestedAt.toString(),
    decidedAt: state.decidedAt?.toString() ?? null,
    needsCertificate: certificate === undefined ? waiting : waiting && certificate === 'missing',
    ...(certificate === undefined ? {} : { certificate }),
    version: state.version,
  };
}

/** Appends the status event of a membership in the open unit. */
export async function announce(
  outbox: OutboxWriter,
  context: CallContext,
  state: SellerCultureState,
): Promise<void> {
  await outbox.append(context, [
    SellerCultureStatusChanged.record({
      aggregateId: derivedId<'SellerCulture'>(`seller-culture:${state.sellerId}`, state.cultureId),
      aggregateVersion: state.version,
      occurredAt: state.updatedAt,
      payload: { sellerId: state.sellerId, cultureId: state.cultureId, status: state.status },
    }),
  ]);
}
