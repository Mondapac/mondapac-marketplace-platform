import type { Offer, OffSaleCause, OfferHandling, OfferStatus } from '../../domain/offer';
import type { ProductLabel } from '../ports/own-catalog.reader';
import { isoOf } from './own-reads.shared';

export interface OwnOfferView {
  readonly offerId: string;
  readonly productId: string;
  /** The Offer's product: its code, type and published name in the default locale (else null). */
  readonly product: {
    readonly productCode: string | null;
    readonly typeCode: string | null;
    readonly name: string | null;
  };
  readonly sellerSku: string;
  readonly conditionCode: string;
  readonly description: Readonly<Record<string, string>>;
  readonly status: OfferStatus;
  readonly listed: boolean;
  readonly offSaleCauses: readonly OffSaleCause[];
  readonly handling: OfferHandling | null;
  readonly attestationRecorded: boolean;
  readonly submittedAt: string | null;
  readonly firstPublishedAt: string | null;
  readonly createdAt: string;
  readonly version: number;
}

export function offerViewOf(offer: Offer, label: ProductLabel | undefined): OwnOfferView {
  const { state } = offer;
  return {
    offerId: state.id,
    productId: state.productId,
    product: {
      productCode: label?.productCode ?? null,
      typeCode: label?.typeCode ?? null,
      name: label?.name ?? null,
    },
    sellerSku: state.sellerSku,
    conditionCode: state.conditionCode,
    description: state.description,
    status: state.status,
    listed: state.listed,
    offSaleCauses: state.offSaleCauses,
    handling: state.handling,
    attestationRecorded: state.attestationRecordedAt !== null,
    submittedAt: isoOf(state.submittedAt),
    firstPublishedAt: isoOf(state.firstPublishedAt),
    createdAt: state.createdAt.toString(),
    version: state.version,
  };
}
