import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_TYPE_VIEW } from '../../contracts/permissions';
import { isClosedTypeStatus, type ProposalSubject, type TypeStatus } from '../../domain/registry';
import {
  adminOf,
  invalid,
  registryFailure,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface TypesListOutput {
  readonly items: readonly {
    readonly typeId: string;
    readonly code: string;
    readonly status: TypeStatus;
    readonly verificationMode: string;
    readonly version: number;
    readonly publishedRevisionId: string;
    readonly publishedRevisionNo: number;
    readonly names: Readonly<Record<string, string>>;
    /** The kinds of proposal waiting for a second admin. */
    readonly pending: readonly ProposalSubject[];
  }[];
}

export interface TypesListInput {
  /** Also list rejected and withdrawn proposals of new types ("Show closed proposals"). */
  readonly closed?: unknown;
}

export type TypesListFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

/**
 * `types.list` (certification design 3.6, 7.2; slice 12): every certification type of the Market
 * with its status, published revision and names, and which proposals wait. A proposed new type is
 * listed (FE-091); rejected and withdrawn ones only when `closed` is true. Rule: key
 * `certification.type.view`, the admin population. Reads only.
 */
export class TypesList extends UseCase<TypesListInput, TypesListOutput, TypesListFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.types-list',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_TYPE_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: TypesListInput,
  ): Promise<Result<TypesListOutput, TypesListFailure>> {
    if (adminOf(context, { write: false }) === null) return err({ code: 'access.denied' });
    const closed = input?.closed ?? false;
    if (typeof closed !== 'boolean') return invalid('closed', 'type');
    const { market } = context;
    const { deps } = this;
    return deps.unitOfWork
      .run<TypesListOutput, TypesListFailure>(
        market,
        async () => {
          const rows = await deps.registry.listTypes(market);
          return ok({
            items: rows
              .filter((row) => closed || !isClosedTypeStatus(row.type.status))
              .map((row) => ({
                typeId: row.type.id,
                code: row.type.code,
                status: row.type.status,
                verificationMode: row.type.verificationMode,
                version: row.type.version,
                publishedRevisionId: row.type.publishedRevisionId,
                publishedRevisionNo: row.publishedRevisionNo,
                names: row.names,
                pending: row.pendingSubjects,
              })),
          });
        },
        { readOnly: true },
      )
      .catch((error: unknown) => registryFailure(context, 'certification.types-list', error));
  }
}
