import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import { IssuerRequestViewed } from '../../domain/audit';
import type { IssuerRequestState } from '../../domain/issuer-request';
import {
  issuerRequestReasonsOf,
  parseIssuerRequestId,
  type IssuerRequestDependencies,
} from '../issuer-requests/issuer-request.shared';
import { documentViewOf, type DocumentView } from '../own/own-certificate.shared';
import type { IssuerChoice } from '../ports/certificate-type-catalog';
import type { StoredIssuerRequest } from '../ports/issuer-request.repository';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ValidationFailure,
} from '../review/review.shared';

export interface IssuerRequestReadInput {
  readonly issuerRequestId: unknown;
}

export interface IssuerRequestPage {
  readonly issuerRequestId: string;
  readonly version: number;
  readonly state: IssuerRequestState;
  readonly typeCode: string;
  readonly sellerId: string;
  readonly storeName: string | null;
  /**
   * The issuer's name as the seller typed it, decrypted for this reader: seller text, shown as
   * plain text, never a registry value. Null when the seller's key is gone (erasure).
   */
  readonly typedIssuerName: string | null;
  readonly documents: readonly DocumentView[];
  readonly createdAt: string;
  readonly answer: {
    readonly issuerId: string | null;
    readonly reasonCode: string | null;
    readonly answeredAt: string;
  } | null;
  /** For the answer form: the active issuers of the type and the Market's reasons. */
  readonly activeIssuers: readonly { readonly issuerId: string; readonly displayName: string }[];
  readonly reasons: readonly { readonly code: string; readonly label: string }[];
}

export type IssuerRequestReadFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer-request.not-found' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `issuer-requests.read` (certification design 7.2, 3.5): one request for the admin who answers
 * it, with the typed name decrypted under the seller's key, the files' metadata, the active issuers
 * of its type and the Market's reasons for a "not accepted" answer. Each read writes
 * `certification.issuer-request.viewed` (ids only) before the answer leaves; a refused row
 * returns nothing. Served with `Cache-Control: private, no-store`. Rule: key
 * `certification.issuer.view` and the admin population.
 */
export class IssuerRequestRead extends UseCase<
  IssuerRequestReadInput,
  IssuerRequestPage,
  IssuerRequestReadFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-request-read',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerRequestReadInput,
  ): Promise<Result<IssuerRequestPage, IssuerRequestReadFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const id = parseIssuerRequestId(input.issuerRequestId);
    if (id === null) return invalid('issuerRequestId', 'format');

    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run<{ request: StoredIssuerRequest; issuers: readonly IssuerChoice[] } | null, never>(
        market,
        async () => {
          const request = await deps.requests.find(market, id);
          if (request === null) return ok(null);
          return ok({ request, issuers: await deps.types.activeIssuers(market, request.typeId) });
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.issuer-request.read', error),
      );
    if (!read.ok) return read;
    if (read.value === null) return err({ code: 'issuer-request.not-found' });
    const { request, issuers } = read.value;

    let typedIssuerName: string | null;
    try {
      const opened = await deps.cipher.open(
        market,
        request.sellerId,
        'issuer-request-typed-name',
        request.typedNameCiphertext,
      );
      typedIssuerName = opened.ok ? opened.value : null;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const names = await deps.sellers.storeNames(context, [request.sellerId]);
    const reasons = issuerRequestReasonsOf(deps, market) ?? [];

    const audited = await deps.unitOfWork
      .run(market, async () => {
        await deps.audit.record(
          context,
          IssuerRequestViewed.entry(id, { after: { sellerId: request.sellerId } }),
        );
        return ok(undefined);
      })
      .catch((error: unknown) =>
        reviewFailure(context, 'certification.issuer-request.read.audit', error),
      );
    if (!audited.ok) return err({ code: 'access.unavailable' });

    return ok({
      issuerRequestId: request.id,
      version: request.version,
      state: request.state,
      typeCode: request.typeCode,
      sellerId: request.sellerId,
      storeName: names.get(request.sellerId) ?? null,
      typedIssuerName,
      documents: request.documents.map(documentViewOf),
      createdAt: request.createdAt.toString(),
      answer:
        request.answeredAt === null
          ? null
          : {
              issuerId: request.issuerId,
              reasonCode: request.answerReasonCode,
              answeredAt: request.answeredAt.toString(),
            },
      activeIssuers: issuers.map((issuer) => ({
        issuerId: issuer.id,
        displayName: issuer.displayName,
      })),
      reasons: reasons.map(({ code, label }) => ({ code, label })),
    });
  }
}
