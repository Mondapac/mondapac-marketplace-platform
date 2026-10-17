import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_VIEW } from '../../contracts/permissions';
import type { IssuerState } from '../../domain/issuer';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  parseTypeId,
  registryFailure,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuersListInput {
  readonly typeId?: unknown;
  readonly state?: unknown;
  readonly afterId?: unknown;
  readonly limit?: unknown;
}

export interface IssuerSummary {
  readonly issuerId: string;
  readonly typeId: string;
  readonly typeCode: string;
  readonly displayName: string;
  readonly accreditationNumber: string | null;
  readonly state: IssuerState;
  readonly version: number;
  readonly stateChangedAt: string;
}

export interface IssuersListOutput {
  readonly items: readonly IssuerSummary[];
  readonly nextAfterId: string | null;
}

export type IssuersListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const STATES: readonly string[] = ['proposed', 'active', 'closed-to-new', 'derecognised'];
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

/**
 * `issuers.list` (certification design 3.5, 7.2; CERT-04; slice 12): the registry of the Market,
 * every state (an issuer is never deleted), optionally one type and one state, by id in pages of
 * at most 100. Clear fields only: never the expert reference. Rule: key
 * `certification.issuer.view`, the admin population.
 */
export class IssuersList extends UseCase<IssuersListInput, IssuersListOutput, IssuersListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuers-list',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuersListInput,
  ): Promise<Result<IssuersListOutput, IssuersListFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    const query = typeof input === 'object' && input !== null ? input : {};
    const typeId = query.typeId === undefined ? null : parseTypeId(query.typeId);
    if (query.typeId !== undefined && typeId === null) return invalid('typeId', 'format');
    if (query.state !== undefined && !STATES.includes(query.state as string)) {
      return invalid('state', 'unknown');
    }
    const state = (query.state as IssuerState | undefined) ?? null;
    const afterId = query.afterId === undefined ? null : parseRegistryIssuerId(query.afterId);
    if (query.afterId !== undefined && afterId === null) return invalid('afterId', 'format');
    const limit = query.limit === undefined ? DEFAULT_LIMIT : query.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      return invalid('limit', 'range');
    }
    const { deps } = this;
    const { market } = context;
    return deps.unitOfWork
      .run<IssuersListOutput, IssuersListFailure>(
        market,
        async () => {
          const rows = await deps.registry.listIssuers(market, {
            typeId,
            state,
            afterId,
            limit: limit + 1,
          });
          const page = rows.slice(0, limit);
          return ok({
            items: page.map((issuer) => ({
              issuerId: issuer.id,
              typeId: issuer.typeId,
              typeCode: issuer.typeCode,
              displayName: issuer.displayName,
              accreditationNumber: issuer.accreditationNumber,
              state: issuer.state,
              version: issuer.version,
              stateChangedAt: issuer.stateChangedAt.toString(),
            })),
            nextAfterId: rows.length > limit ? page[page.length - 1]!.id : null,
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => registryFailure(context, 'certification.issuers-list', error));
  }
}
