import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_OWN_CERTIFICATE_MANAGE } from '../../contracts/permissions';
import {
  issuerRequestTypeRefusal,
  parseTypedIssuerName,
  type IssuerRequestTypeRefusal,
} from '../../domain/issuer-request';
import {
  ISSUER_REQUEST_LIMITS,
  UNAPPROVED_UPLOAD_LIMITS,
  UPLOAD_LIMITS,
} from '../../domain/rate-limits';
import { MAX_DOCUMENT_BYTES, type DocumentRefusalCode } from '../intake/document-inspection';
import type { IssuerRequestDependencies } from '../issuer-requests/issuer-request.shared';
import {
  invalid,
  ownerOf,
  reserveLimits,
  storeFailure,
  type RateFailure,
  type ValidationFailure,
} from '../own/own-certificate.shared';
import type { VaultedDocument } from '../ports/document-ports';

export interface OwnIssuerRequestCreateInput {
  /** The code of an active registry type of the Market. */
  readonly typeCode: unknown;
  /** The issuer's name as the seller types it: request text only (brief s4 a 3). */
  readonly issuerName: unknown;
  /** The file as standard base64 text; the type comes from the decoded content. */
  readonly data: unknown;
}

/** What the seller sees of a sent request: never the typed name back. */
export interface OwnIssuerRequestView {
  readonly issuerRequestId: string;
  readonly typeCode: string;
  readonly state: 'open';
  readonly createdAt: string;
}

export type OwnIssuerRequestCreateFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'type.not-found' }
  | IssuerRequestTypeRefusal
  | { readonly code: 'issuer-request.already-open' }
  | { readonly code: 'conflict.stale' }
  | { readonly code: DocumentRefusalCode }
  | RateFailure
  | ValidationFailure;

const TYPE_CODE = /^[a-z][a-z0-9-]{1,31}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/** Seconds a seller is told to wait when the file intake queue is full. */
const INTAKE_BUSY_RETRY_SECONDS = 5;

/**
 * `own-issuer-request.create` (certification design 2.1, 7.2; brief s4 a 3): "my issuer is not
 * listed". A seller of an active registry type sends the issuer's name as typed and one file; the
 * request waits in the admin queue and the seller's draft of that type shows
 * `draft-issuer-not-listed`. The typed name is encrypted under the seller's key and is request text
 * only: it never becomes an issuer, a draft field or a submission field (AC 11), and it never
 * reaches an event, an audit row, a log line or a mail. The file goes through the same intake as a
 * certificate file and is stored with the purpose `issuer-request`. A seller has at most one open
 * request per type (`issuer-request.already-open`). Limits: 3 requests a day per seller and the
 * seller's upload budget, charged before every other check, a refused request included. Rule: key `certification.own-certificate.manage`, allowed
 * for a seller not yet approved; an acting-as session is refused, and so is an unsure one (M5).
 */
export class OwnIssuerRequestCreate extends UseCase<
  OwnIssuerRequestCreateInput,
  OwnIssuerRequestView,
  OwnIssuerRequestCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.own-issuer-request-create',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_OWN_CERTIFICATE_MANAGE.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: IssuerRequestDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnIssuerRequestCreateInput,
  ): Promise<Result<OwnIssuerRequestView, OwnIssuerRequestCreateFailure>> {
    const owner = ownerOf(context, { write: true });
    if (owner === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    if (typeof input.typeCode !== 'string' || !TYPE_CODE.test(input.typeCode)) {
      return invalid('typeCode', 'format');
    }
    const typeCode = input.typeCode;
    const name = parseTypedIssuerName(input.issuerName);
    if (!name.ok) return invalid('issuerName', name.error.code);
    if (typeof input.data !== 'string' || input.data.length === 0) {
      return invalid('data', 'required');
    }
    if (input.data.length > Math.ceil((MAX_DOCUMENT_BYTES * 4) / 3) + 4) {
      return err({ code: 'file.too-large' });
    }
    if (input.data.length % 4 !== 0 || !BASE64.test(input.data)) return invalid('data', 'format');

    const { deps } = this;
    const { market } = context;

    // The request budget and the upload budget (design 7.5): a seller with an approved revision
    // has a zone and the larger upload budget.
    let approved: boolean;
    try {
      const zones = await deps.zones.zonesOf(context, [owner.sellerId]);
      approved = zones.get(owner.sellerId)?.zone != null;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const throttled = await reserveLimits(
      deps,
      context,
      [...ISSUER_REQUEST_LIMITS, ...(approved ? UPLOAD_LIMITS : UNAPPROVED_UPLOAD_LIMITS)].map(
        (limit) => ({ limit, subject: owner.sellerId }),
      ),
    );
    if (throttled !== null) return err(throttled);

    // Cheap check first: the type exists, is active and takes its issuer from the registry.
    const checked = await deps.unitOfWork
      .run<Id<'CertificationType'>, OwnIssuerRequestCreateFailure>(
        market,
        async () => {
          const type = await deps.types.typeByCode(market, typeCode);
          if (type === null) return err({ code: 'type.not-found' } as const);
          const refusal = issuerRequestTypeRefusal(type);
          if (refusal !== null) return err(refusal);
          // One open request per seller and type: refused before the file work.
          if (await deps.requests.hasOpen(market, owner.sellerId, type.typeId)) {
            return err({ code: 'issuer-request.already-open' } as const);
          }
          return ok(type.typeId);
        },
        { readOnly: true },
      )
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-issuer-request-create.read', error),
      );
    if (!checked.ok) return checked;
    const typeId = checked.value;

    const bytes = Buffer.from(input.data, 'base64');
    if (bytes.length > MAX_DOCUMENT_BYTES) return err({ code: 'file.too-large' });
    const inspected = await deps.intake.inspect(bytes);
    if (!inspected.ok) {
      if (inspected.error.code === 'request.throttled') {
        return err({ code: 'request.throttled', retryAfterSeconds: INTAKE_BUSY_RETRY_SECONDS });
      }
      return err(inspected.error);
    }
    const file = inspected.value;

    // Outside the unit: the typed name and the file, both under the seller's key.
    let typedNameCiphertext: string;
    try {
      const sealed = await deps.cipher.seal(
        market,
        owner.sellerId,
        'issuer-request-typed-name',
        name.value,
      );
      if (!sealed.ok) return err({ code: 'access.denied' });
      typedNameCiphertext = sealed.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const documentId = deps.ids.next<'UploadedDocument'>();
    let vaulted: VaultedDocument;
    try {
      const sealed = await deps.vault.seal(market, owner.sellerId, documentId, file.bytes);
      if (!sealed.ok) return err({ code: 'access.denied' });
      vaulted = sealed.value;
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const now = deps.clock.now();
    const id = deps.ids.next<'IssuerRequest'>();
    const written = await deps.unitOfWork
      .run<OwnIssuerRequestView, OwnIssuerRequestCreateFailure>(market, async () => {
        // Again in the unit: the type may have gone inactive meanwhile.
        const type = await deps.types.typeByCode(market, typeCode);
        if (type === null || type.typeId !== typeId) {
          return err({ code: 'type.not-found' } as const);
        }
        const refusal = issuerRequestTypeRefusal(type);
        if (refusal !== null) return err(refusal);
        const added = await deps.requests.add(market, {
          id,
          sellerId: owner.sellerId,
          typeId,
          typedNameCiphertext,
          document: {
            id: documentId,
            mediaType: file.mediaType,
            byteSize: file.bytes.length,
            pageCount: file.pageCount,
            objectKey: vaulted.objectKey,
            dataKeyEnvelope: vaulted.dataKeyEnvelope,
            cleanSha256: vaulted.cleanSha256,
          },
          now,
        });
        // A request sent meanwhile (the unique partial index); the unit rolls back.
        if (added !== null) return err({ code: added });
        return ok({ issuerRequestId: id, typeCode, state: 'open', createdAt: now.toString() });
      })
      .catch((error: unknown) =>
        storeFailure(context, 'certification.own-issuer-request-create.write', error),
      );
    if (!written.ok) await deps.vault.discard(vaulted.objectKey).catch(() => undefined);
    return written;
  }
}
