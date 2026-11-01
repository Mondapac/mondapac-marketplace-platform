import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AuthorisationCheck,
  type UseCaseGate,
} from '../../../../platform/authz';
import {
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_PRODUCT_PAUSE,
} from '../../contracts/permissions';
import type {
  SubmitProduct,
  SubmitProductFailure,
  SubmitProductOutput,
} from '../revisions/submit-product.service';

export interface PlatformImportRowSubmitInput {
  readonly productId: string;
  /** What the admin chose at the confirm: `inactive` publishes and pauses in one unit. */
  readonly startAs: 'inactive' | 'active';
}

export type PlatformImportRowSubmitFailure =
  | SubmitProductFailure
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformImportRowSubmitDependencies {
  readonly submit: SubmitProduct;
  readonly authorisation: AuthorisationCheck;
}

/**
 * `platform-import.row-submit` (catalog design 14a): the submit of one row of an admin import, in
 * one step with the status the admin chose. **Active** is `platform-product.submit`: the revision
 * publishes at once. **Inactive** publishes it *and pauses it in the same unit*, with both events and
 * the pause audit in one outbox and audit unit, so a product of an import is never visible
 * published and a failed pause rolls the publish back. Inactive also needs
 * `catalog.product.pause`, checked here for the admin the job runs as (the start checked it too).
 * Rule: the keys `catalog.platform-product.edit` and `catalog.platform-import.run`. No route calls
 * it: only the import run.
 */
export class PlatformImportRowSubmit extends UseCase<
  PlatformImportRowSubmitInput,
  SubmitProductOutput,
  PlatformImportRowSubmitFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-row-submit',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key, CATALOG_PLATFORM_IMPORT_RUN.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportRowSubmitDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportRowSubmitInput,
  ): Promise<Result<SubmitProductOutput, PlatformImportRowSubmitFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const fail = (path: string, code: string): Result<never, PlatformImportRowSubmitFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (input.startAs !== 'inactive' && input.startAs !== 'active') return fail('startAs', 'type');
    if (input.startAs === 'inactive') {
      const decision = await this.deps.authorisation.check(context, {
        name: 'catalog.platform-import-row-submit-inactive',
        rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_PAUSE.key] },
      });
      if (!decision.allowed) return err({ code: 'access.denied' });
    }
    return this.deps.submit.execute(context, {
      productId: product.value,
      replacePending: false,
      pauseOnPublish: input.startAs === 'inactive',
    });
  }
}
