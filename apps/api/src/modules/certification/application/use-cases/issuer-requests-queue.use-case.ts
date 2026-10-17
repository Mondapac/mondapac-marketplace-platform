import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import type { IssuerRequestDependencies } from '../issuer-requests/issuer-request.shared';
import type { IssuerRequestQueueEntry } from '../ports/issuer-request.repository';
import {
  invalid,
  reviewerOf,
  reviewFailure,
  type ValidationFailure,
} from '../review/review.shared';

export const ISSUER_QUEUE_DEFAULT_PAGE_SIZE = 25;
export const ISSUER_QUEUE_MAX_PAGE_SIZE = 50;
/** The most open requests one read takes (tens in a Market; design 7.5 caps 3 a seller a day). */
const ISSUER_QUEUE_READ_CAP = 500;

export interface IssuerRequestsQueueInput {
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

/** One open request: clear fields only, with the seller's public store name (no typed name). */
export interface IssuerQueueRow {
  readonly issuerRequestId: string;
  /** The version an answer must name. */
  readonly version: number;
  readonly typeCode: string;
  readonly sellerId: string;
  /** Null for a seller with no approved revision: the panel shows "not yet approved". */
  readonly storeName: string | null;
  readonly documentCount: number;
  readonly createdAt: string;
}

export interface IssuerRequestsQueueOutput {
  readonly items: readonly IssuerQueueRow[];
  readonly nextAfterId: string | null;
  readonly total: number;
}

export type IssuerRequestsQueueFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

interface Position {
  readonly at: number;
  readonly id: string;
}

const CURSOR = /^(\d{1,15})_([0-9a-f-]{36})$/;
const positionOf = (entry: IssuerRequestQueueEntry): Position => ({
  at: entry.createdAt.epochMilliseconds,
  id: entry.id,
});
const cursorOf = (p: Position): string => `${p.at}_${p.id}`;
const before = (a: Position, b: Position): boolean => (a.at !== b.at ? a.at < b.at : a.id < b.id);

function parseCursor(value: unknown): Result<Position | null, ValidationFailure> {
  if (value === undefined || value === null) return ok(null);
  const match = typeof value === 'string' ? CURSOR.exec(value) : null;
  const id = match?.[2] === undefined ? null : parseId(match[2]);
  if (match === null || id === null || !id.ok) return invalid('afterId', 'format');
  return ok({ at: Number(match[1]), id: id.value });
}

/**
 * `issuer-requests.list` (certification design 7.2, 3.5; brief s4 b 4): the open "my issuer is not
 * listed" requests of the Market, oldest first, keyset-paged. Each row carries the type, the seller
 * and its public store name (one `sellers` call per page), and the number of files; the typed name
 * is not in the list (it is decrypted only on the audited read of one request). Rule: key
 * `certification.issuer.view` and the admin population.
 */
export class IssuerRequestsQueue extends UseCase<
  IssuerRequestsQueueInput,
  IssuerRequestsQueueOutput,
  IssuerRequestsQueueFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-requests-queue',
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
    input: IssuerRequestsQueueInput,
  ): Promise<Result<IssuerRequestsQueueOutput, IssuerRequestsQueueFailure>> {
    if (reviewerOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return invalid('query', 'type');
    }
    const cursor = parseCursor(input.afterId);
    if (!cursor.ok) return cursor;
    let limit = ISSUER_QUEUE_DEFAULT_PAGE_SIZE;
    if (input.limit !== undefined && input.limit !== null) {
      if (typeof input.limit !== 'number' || !Number.isInteger(input.limit)) {
        return invalid('limit', 'type');
      }
      if (input.limit < 1 || input.limit > ISSUER_QUEUE_MAX_PAGE_SIZE) {
        return invalid('limit', 'range');
      }
      limit = input.limit;
    }

    const { deps } = this;
    const { market } = context;
    const read = await deps.unitOfWork
      .run(market, async () => ok(await deps.requests.openQueue(market, ISSUER_QUEUE_READ_CAP)), {
        readOnly: true,
      })
      .catch((error: unknown) => reviewFailure(context, 'certification.issuer-queue.read', error));
    if (!read.ok) return read;

    const ordered = [...read.value].sort((a, b) => {
      const pa = positionOf(a);
      const pb = positionOf(b);
      return before(pa, pb) ? -1 : before(pb, pa) ? 1 : 0;
    });
    const after = cursor.value;
    const rest = after === null ? ordered : ordered.filter((e) => before(after, positionOf(e)));
    const shown = rest.slice(0, limit);
    const last = shown[shown.length - 1];
    const names = await deps.sellers.storeNames(context, [
      ...new Set(shown.map((entry) => entry.sellerId)),
    ]);

    return ok({
      items: shown.map((entry) => ({
        issuerRequestId: entry.id,
        version: entry.version,
        typeCode: entry.typeCode,
        sellerId: entry.sellerId,
        storeName: names.get(entry.sellerId) ?? null,
        documentCount: entry.documentCount,
        createdAt: entry.createdAt.toString(),
      })),
      nextAfterId:
        rest.length > shown.length && last !== undefined ? cursorOf(positionOf(last)) : null,
      total: ordered.length,
    });
  }
}
