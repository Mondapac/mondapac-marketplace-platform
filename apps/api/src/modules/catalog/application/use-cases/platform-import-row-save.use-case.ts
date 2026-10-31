import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CATALOG_PLATFORM_IMPORT_RUN,
  CATALOG_PLATFORM_PRODUCT_EDIT,
} from '../../contracts/permissions';
import {
  parseSaveDraftInput,
  type SaveDraftRequest,
  type SaveDraftRequestFailure,
} from '../working-copy/parse-save-draft-input';
import type {
  SaveDraft,
  SaveDraftFailure,
  SaveDraftOutput,
} from '../working-copy/save-draft.service';

export type PlatformImportRowSaveInput = SaveDraftRequest;
export type PlatformImportRowSaveFailure = SaveDraftFailure | SaveDraftRequestFailure;

export interface PlatformImportRowSaveDependencies {
  readonly saveDraft: SaveDraft;
}

/**
 * `platform-import.row-save` (catalog design 14a, "Limits of a run"): the draft save of one row of an
 * admin import. It is `platform-product.save-draft` for the job: the same service, so the
 * attribute schema, the claim-text control and the variant registry are the same, and the same
 * author rule (an admin, a PLATFORM product), but it **does not spend the interactive draft-save
 * limit** of the account (60 a minute, 1,000 a day), which a 5,000-row import would exhaust. The
 * import is bounded by its own limits instead: at most 5,000 rows, one running import per admin, 10
 * starts a day, and a fixed work per row (one create, one save, one submit, texts of at most 10,000
 * characters). Rule: the keys `catalog.platform-product.edit` and `catalog.platform-import.run`,
 * so an admin who lost either stops the run. No route calls it: only the import run, as the admin
 * who started the import; the interactive routes keep `platform-product.save-draft` and its limits.
 */
export class PlatformImportRowSave extends UseCase<
  PlatformImportRowSaveInput,
  SaveDraftOutput,
  PlatformImportRowSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-import-row-save',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key, CATALOG_PLATFORM_IMPORT_RUN.key],
    },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformImportRowSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformImportRowSaveInput,
  ): Promise<Result<SaveDraftOutput, PlatformImportRowSaveFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseSaveDraftInput(input);
    if (!parsed.ok) return parsed;
    return this.deps.saveDraft.execute(context, parsed.value, { spendSavesLimit: false });
  }
}
