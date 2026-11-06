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
  /** The requester's account id (design 8.2); their display name waits for an identity read. */
  readonly requestedByAccountId: string;
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
 * part 3): the Market's open requests to turn off Material that are still in time (archive requests have their own list), oldest first, with the attribute's
 * code, names and version and what the reader may do: confirm another admin's request, cancel
 * their own (`relaxation.same-admin` and `relaxation.not-requester` otherwise). The requester is
 * shown by account id and as `mine` or not: the admin name lookup is a later identity read. Rule: the key
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
    private readonly deps: OpenRequestListDependencies,
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
    const requests = await openRequestViews(
      this.deps,
      context,
      accountId,
      (kind) => kind !== 'archive',
    );
    if (!requests.ok) return requests;
    return ok({ requests: requests.value });
  }
}

/** The dependencies the open-request lists read. */
export type OpenRequestListDependencies = Pick<
  AttributeRelaxationDependencies,
  'unitOfWork' | 'attributeStore' | 'relaxations' | 'clock'
>;

/**
 * The open requests whose kind `include` accepts, oldest first, in one read-only unit. Both lists
 * use it: the clear-material list (key `catalog.attribute.edit`) and the archive list (key
 * `catalog.attribute.restructure`), so each key reads only the requests it can decide.
 */
export async function openRequestViews(
  deps: OpenRequestListDependencies,
  context: CallContext,
  accountId: string,
  include: (kind: string) => boolean,
) {
  const { market } = context;
  return deps.unitOfWork.run<OpenRelaxationView[], never>(
    market,
    async () => {
      const open = await deps.relaxations.listOpen(market, deps.clock.now(), LIST_MAX);
      const views: OpenRelaxationView[] = [];
      for (const request of open) {
        const state = request.state;
        if (!include(state.kind)) continue;
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
          requestedByAccountId: state.requestedByAccountId,
          requestedAt: state.requestedAt.toString(),
          expiresAt: state.expiresAt.toString(),
          allowedActions: {
            confirm: mine ? { allowed: false, reason: 'relaxation.same-admin' } : { allowed: true },
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
}
