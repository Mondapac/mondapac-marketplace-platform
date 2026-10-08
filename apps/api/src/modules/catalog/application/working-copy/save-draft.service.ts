import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { changedTexts, draftTextsOf, restoreRefused } from '../../domain/draft-texts';
import { isStorableContent } from '../../domain/working-copy';
import type { ClaimCheckedFieldId } from '../../domain/claim-checked-fields';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { CheckClaimText, ClaimTextVerdict } from '../claim-text/check-claim-text.service';
import type { ClaimTextMatch } from '../ports/claim-text-matcher';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type {
  SaveWorkingCopy,
  SaveWorkingCopyFailure,
  SaveWorkingCopyOutput,
} from './save-working-copy.service';

export interface SaveDraftInput {
  readonly productId: Id<'Product'>;
  /** Opaque JSON object from the request; this service checks its shape and its texts. */
  readonly content: unknown;
  readonly variantIds: readonly (Id<'Variant'> | null)[];
}

/** A checked text that was not written, and why (catalog design 6.1, ux.md 7.2). */
export type RefusedField = {
  readonly field: ClaimCheckedFieldId;
  readonly ref: string | null;
  readonly locale: string;
} & (
  | { readonly code: 'claim-text.found'; readonly hits: readonly ClaimTextMatch[] }
  | { readonly code: 'claim-text.check-unavailable' }
  | {
      readonly code: 'text.invisible-character';
      readonly offset: number;
      readonly character: 'ZWNJ' | 'ZWJ' | 'other';
    }
);

export interface SaveDraftOutput extends SaveWorkingCopyOutput {
  /** Texts that kept their last saved value; everything else of the request was saved. */
  readonly refusedFields: readonly RefusedField[];
}

export type SaveDraftFailure =
  SaveWorkingCopyFailure | { readonly code: 'working-copy.invalid-content' };

export interface SaveDraftDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly check: CheckClaimText;
  readonly save: SaveWorkingCopy;
  readonly workingCopies: WorkingCopyRepository;
  readonly policy: CatalogMarketPolicy;
}

/**
 * The draft save with the claim-text control (catalog design 6.1; slice 6): an internal service
 * that `platform-product.save-draft` (and, in slice 7, `own-product.save-draft`) declare their
 * access rule around.
 *
 * 1. The draft must fit the closed shape of {@link draftTextsOf}: a key, locale or nesting it
 *    does not name refuses the whole save (`working-copy.invalid-content`), so no string can sit
 *    where the check does not look.
 * 2. Only the texts that differ from the stored draft are checked. A text that matches, holds a
 *    hidden character or cannot be checked is **not written**: it keeps its last saved value (or
 *    has none), and the answer lists it in `refusedFields`. Everything else is saved in the same
 *    unit by {@link SaveWorkingCopy}, which owns the actor, the ownership check, the saves limit
 *    and the variant registry.
 *
 * The stored draft is read before the save unit and used only to decide what changed and what to
 * restore; it is never returned. Another seller's or Market's product id is answered by the save
 * as `product.not-found`, whatever this service computed. A concurrent save of the same draft is
 * last-write-wins, as in {@link SaveWorkingCopy}: every string written was checked now or equals
 * a value that was checked when it was stored.
 */
export class SaveDraft {
  constructor(private readonly deps: SaveDraftDependencies) {}

  async execute(
    context: CallContext,
    input: SaveDraftInput,
  ): Promise<Result<SaveDraftOutput, SaveDraftFailure>> {
    if (!isStorableContent(input.content)) return err({ code: 'working-copy.invalid-content' });
    const content = input.content;
    const { market } = context;

    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const texts = draftTextsOf(content, locales.supported, locales.default);
    if (!texts.ok) return err(texts.error);

    // The saves limit is spent before the read and the check, so a throttled account costs the
    // matcher nothing (Hassan M2).
    const throttled = await this.deps.save.reserveSaves(context);
    if (throttled !== null) return err(throttled);

    // A read-only unit opens no transaction (ADR-0025); the save below opens its own.
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await this.deps.workingCopies.find(market, input.productId)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    const stored = read.value;
    const changed = changedTexts(content, texts.value, stored?.content ?? null);

    let refused: readonly RefusedField[] = [];
    let amended: Record<string, unknown> = content;
    if (changed.length > 0) {
      const checked = await this.deps.check.execute(
        context,
        changed.map(({ field, ref, locale, text }) => ({ field, ref, locale, text })),
      );
      if (!checked.ok) {
        // A caller who may not check may not save; a request the check refuses is not a draft.
        return err(
          checked.error.code === 'validation.failed'
            ? { code: 'working-copy.invalid-content' }
            : checked.error.code === 'request.throttled'
              ? { code: 'access.unavailable' }
              : checked.error,
        );
      }
      const refusedPaths: (typeof changed)[number]['path'][] = [];
      const list: RefusedField[] = [];
      checked.value.forEach((verdict, index) => {
        const refusal = refusalOf(verdict);
        if (refusal === null) return;
        list.push(refusal);
        refusedPaths.push(changed[index]!.path);
      });
      refused = list;
      const restored = restoreRefused(content, stored?.content ?? null, refusedPaths);
      if (restored === null) return err({ code: 'working-copy.invalid-content' });
      amended = restored;
    }

    const saved = await this.deps.save.execute(
      context,
      { productId: input.productId, content: amended, variantIds: input.variantIds },
      { savesReserved: true },
    );
    if (!saved.ok) return saved;
    return ok({ ...saved.value, refusedFields: refused });
  }
}

export function refusalOf(verdict: ClaimTextVerdict): RefusedField | null {
  const place = { field: verdict.field, ref: verdict.ref, locale: verdict.locale };
  switch (verdict.code) {
    case 'clean':
      return null;
    case 'claim-text.found':
      return { ...place, code: verdict.code, hits: verdict.hits };
    case 'claim-text.check-unavailable':
      return { ...place, code: verdict.code };
    case 'text.invisible-character':
      return { ...place, code: verdict.code, offset: verdict.offset, character: verdict.character };
  }
}
