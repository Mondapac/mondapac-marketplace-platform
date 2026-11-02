import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import type { LocalizedText } from '../../domain/attribute-definition';
import {
  closedInput,
  editorAccountOf,
  type ValidationFailure,
} from '../attributes/attribute-editor';
import type { AttributeRelaxationDependencies } from '../attributes/attribute-relaxation';

/** More than a Market has open at once (tens a year); the list is never paged. */
const LIST_MAX = 100;

export interface OpenRelaxationView {
  readonly id: string;
  readonly version: number;
  readonly kind: string;
  readonly attribute: {
    readonly id: string;
    readonly code: string;
    readonly names: LocalizedText;
    readonly version: number;
  };
  /** The reader's own request: they may cancel it, not confirm it. */
  readonly mine: boolean;
  readonly requestedAt: string;
  readonly expiresAt: string;
  readonly allowedActions: {
    readonly confirm:
      { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
    readonly cancel:
      { readonly allowed: true } | { readonly allowed: false; readonly reason: string };
  };
}

export type AttributeRelaxationListOpenFailure =
  ValidationFailure | { readonly code: 'access.denied' };

/**
 * `attribute-relaxations.list-open` (catalog design 8.2, PA7 "Waiting for you"; attributes A2
 * part 3): the Market's open relaxation requests still in time, oldest first, with the attribute's
 * code, names and version and what the reader may do: confirm another admin's request, cancel
 * their own (`relaxation.same-admin` and `relaxation.not-requester` otherwise). The requester is
 * shown only as `mine` or not: the admin name lookup is a later identity read. Rule: the key
 * `catalog.attribute.edit` (protected), the admin population, never in an acting-as session.
 */
export class AttributeRelaxationListOpen extends UseCase<
  Record<string, unknown>,
  { readonly requests: readonly OpenRelaxationView[] },
  AttributeRelaxationListOpenFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-relaxation-list-open',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: Pick<
      AttributeRelaxationDependencies,
      'unitOfWork' | 'attributeStore' | 'relaxations' | 'clock'
    >,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: Record<string, unknown>,
  ): Promise<
    Result<{ readonly requests: readonly OpenRelaxationView[] }, AttributeRelaxationListOpenFailure>
  > {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, []);
    if (!body.ok) return body;
    const { market } = context;
    const { deps } = this;
    const requests = await deps.unitOfWork.run<OpenRelaxationView[], never>(
      market,
      async () => {
        const open = await deps.relaxations.listOpen(market, deps.clock.now(), LIST_MAX);
        const views: OpenRelaxationView[] = [];
        for (const request of open) {
          const state = request.state;
          const definition = await deps.attributeStore.findById(market, state.definitionId);
          if (definition === null) continue;
          const mine = state.requestedByAccountId === accountId;
          views.push({
            id: state.id,
            version: state.version,
            kind: state.kind,
            attribute: {
              id: definition.state.id,
              code: definition.state.code,
              names: definition.state.names,
              version: definition.state.version,
            },
            mine,
            requestedAt: state.requestedAt.toString(),
            expiresAt: state.expiresAt.toString(),
            allowedActions: {
              confirm: mine
                ? { allowed: false, reason: 'relaxation.same-admin' }
                : { allowed: true },
              cancel: mine
                ? { allowed: true }
                : { allowed: false, reason: 'relaxation.not-requester' },
            },
          });
        }
        return ok(views);
      },
      { readOnly: true },
    );
    if (!requests.ok) return requests;
    return ok({ requests: requests.value });
  }
}
